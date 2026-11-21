// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same
// {text, header}: {columns, rows, errors}. The semantics it reproduces,
// taken from the reference (baselines/csv-reader/vendor/csv-reader/index.js):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a record's short_row
//     or long_row when it ends: line the 1-based line its record starts on,
//     counting every LF, CRLF and lone CR inside quotes, and row its record's
//     index in rows, null for the header.
//
// Speed comes from never reading a character twice where one pass will do,
// and from letting C++ do the scanning:
//   - a line with no quote and no stray CR is its own record: it is split on
//     its commas with indexOf and slice, which beats split(',') here;
//   - a line with a quote but no stray CR is read field by field within the
//     line: an unquoted field ends at the next comma or the line's end, and a
//     quoted field's span holds no line break, so neither needs the general
//     reader's terminator search or line counting; a quoted field that does
//     not close on the line falls back to the general reader;
//   - the general reader, for lines with a stray CR and for fields spanning
//     lines, finds an unquoted field's next terminator with indexOf for the
//     comma and the LF (a CR just before that LF is the CRLF half) and reads
//     a quoted field by finding its next quote with indexOf and slicing the
//     span between, converting embedded line breaks only when the span
//     actually holds one;
//   - no per-field objects are allocated: the field readers report through
//     shared locals, and the only arrays built are the output's own.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Node 22, no dependencies.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next terminator of an unquoted field: comma, LF or CR. */
const NEXT_SPECIAL = /[,\n\r]/g;
/** A line break inside a quoted field: CRLF, a lone CR or an LF, each one LF. */
const QUOTED_BREAK = /\r\n?|\n/g;
/** Whether a quoted span holds any line break at all. */
const HAS_BREAK = /[\r\n]/;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and the characters kept while reading it.
  let fv = '';
  let fe = END;
  let fa = 0;

  // The record just read (general path): its fields and whether its last field was quoted.
  let recFields = null;
  let recQuoted = false;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, with `init` already in the value.
  // Sets fv, fe and fa (fa counts only the characters appended here).
  // Fast path: the field holds no CR, so it ends at the nearer of the next
  // comma and the next LF (a CR just before that LF is the CRLF half).
  // Slow path (a CR inside the field): the regex loop below, which drops
  // each stray CR with its error.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iL = text.indexOf('\n', pos);
      let i;
      let kind;
      if (iC !== -1 && (iL === -1 || iC < iL)) {
        i = iC;
        kind = COMMA;
      } else if (iL !== -1) {
        i = iL;
        kind = LINE_BREAK;
      } else {
        i = n;
        kind = END;
      }
      let f = text.slice(pos, i);
      if (kind === LINE_BREAK && f.charCodeAt(f.length - 1) === 13) {
        f = f.slice(0, -1); // the CRLF half: not part of the value
      }
      if (f.indexOf('\r') === -1) {
        if (f.length > 0) {
          value += f;
          added += f.length;
        }
        if (kind === COMMA) pos = i + 1;
        else if (kind === LINE_BREAK) {
          pos = i + 1;
          line += 1;
        } else pos = n;
        fv = value;
        fe = kind;
        fa = added;
        return;
      }
      // A CR inside the field: walk it with the regex loop.
      NEXT_SPECIAL.lastIndex = pos;
      const m = NEXT_SPECIAL.exec(text);
      const j = m.index;
      if (j > pos) {
        value += text.slice(pos, j);
        added += j - pos;
      }
      const c = m[0];
      if (c === ',') {
        pos = j + 1;
        fv = value;
        fe = COMMA;
        fa = added;
        return;
      }
      if (c === '\n') {
        pos = j + 1;
        line += 1;
        fv = value;
        fe = LINE_BREAK;
        fa = added;
        return;
      }
      if (text.charCodeAt(j + 1) === 10) {
        pos = j + 2;
        line += 1;
        fv = value;
        fe = LINE_BREAK;
        fa = added;
        return;
      }
      pushError('stray_cr');
      pos = j + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fv, fe and fa (fa is 0).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        readUnquoted('"');
        return;
      }
      let seg = text.slice(pos, q);
      if (HAS_BREAK.test(seg)) {
        // Each CRLF or lone CR inside quotes is read as one LF.
        seg = seg.replace(QUOTED_BREAK, () => {
          line += 1;
          return '\n';
        });
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote; the field goes on.
        value += seg;
        value += '"';
        pos = q + 2;
        continue;
      }
      // The closing quote.
      value += seg;
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      fv = value;
      fe = END;
      fa = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fv = value;
      fe = COMMA;
      fa = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      fa = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      fa = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fa > 0) pushError('quote_junk');
  }

  // Splits a line that holds no quote and no stray CR on its commas, with
  // indexOf and slice (cheaper than split(',') here). Sets recFields.
  function splitClean(s) {
    const fields = [];
    let start = 0;
    for (;;) {
      const c = s.indexOf(',', start);
      if (c === -1) {
        fields.push(s.slice(start));
        break;
      }
      fields.push(s.slice(start, c));
      start = c + 1;
    }
    recFields = fields;
    recQuoted = false;
  }

  // Reads one record that fits on a single physical line: the line holds a
  // quote but no stray CR (only a trailing CRLF half). Inside one line an
  // unquoted field ends at the next comma or the line's end, and a quoted
  // field's span holds no line break, so neither needs the general reader's
  // terminator search or line counting. Returns true when the record ends
  // on this line; false when a quoted field does not close on it (a field
  // spanning lines, or a quote that never closes): the caller then runs the
  // general reader from the record's start, with the errors and the position
  // this attempt left restored. `contentEnd` is the end of the line's
  // content (the trailing CRLF half excluded); `nl` the position of its LF
  // (-1 when the line runs to the end of the text). Sets recFields/recQuoted.
  function readRecordLine(contentEnd, nl) {
    const startPos = pos;
    const errMark = errors.length;
    const fields = [];
    let quoted = false;
    for (;;) {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) {
        let value = '';
        let p = pos + 1;
        let comma = false;
        for (;;) {
          const q = text.indexOf('"', p);
          if (q === -1 || q >= contentEnd) {
            // Does not close on this line: fall back to the general reader.
            pos = startPos;
            errors.length = errMark;
            return false;
          }
          if (text.charCodeAt(q + 1) === 34) {
            // A doubled quote is one literal quote; the field goes on.
            value += text.slice(p, q);
            value += '"';
            p = q + 2;
            continue;
          }
          value += text.slice(p, q);
          if (q + 1 >= contentEnd) {
            pos = contentEnd;
            break;
          }
          if (text.charCodeAt(q + 1) === 44) {
            pos = q + 2;
            comma = true;
            break;
          }
          // Junk after the closing quote, up to the next comma or the line's end.
          const jC = text.indexOf(',', q + 1);
          const jEnd = jC !== -1 && jC < contentEnd ? jC : contentEnd;
          if (jEnd > q + 1) {
            value += text.slice(q + 1, jEnd);
            pushError('quote_junk');
          }
          if (jC !== -1 && jC < contentEnd) {
            pos = jC + 1;
            comma = true;
          } else {
            pos = contentEnd;
          }
          break;
        }
        fields.push(value);
        if (!comma) break;
      } else {
        const iC = text.indexOf(',', pos);
        const end = iC !== -1 && iC < contentEnd ? iC : contentEnd;
        fields.push(text.slice(pos, end));
        if (iC !== -1 && iC < contentEnd) {
          pos = iC + 1;
        } else {
          pos = contentEnd;
          break;
        }
      }
    }
    // The record ends at the line's end.
    pos = nl === -1 ? n : nl + 1;
    if (nl !== -1) line += 1;
    recFields = fields;
    recQuoted = quoted;
    return true;
  }

  // Reads one record field by field (the record holds a quote or a stray CR,
  // so the line fast path does not apply). Sets recFields and recQuoted.
  function readRecordGeneral() {
    const fields = [];
    let quoted = false;
    for (;;) {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fv);
      if (fe !== COMMA) break;
    }
    recFields = fields;
    recQuoted = quoted;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // A line with no quote and no stray CR is its own record: split it whole.
    // A line with a quote but no stray CR is read field by field within the
    // line; a line with a stray CR goes to the general reader.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    const lineStr = text.slice(pos, segEnd);
    const hasQuote = lineStr.indexOf('"') !== -1;
    const cr = lineStr.indexOf('\r');
    const crIsCRLF = cr === lineStr.length - 1 && nl !== -1;
    if (!hasQuote && cr === -1) {
      splitClean(lineStr);
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
    } else if (!hasQuote && crIsCRLF) {
      // CRLF: the line break, not a stray CR.
      splitClean(lineStr.slice(0, -1));
      pos = nl + 1;
      line += 1;
    } else if (hasQuote && (cr === -1 || crIsCRLF)) {
      if (!readRecordLine(crIsCRLF ? segEnd - 1 : segEnd, nl)) readRecordGeneral();
    } else {
      readRecordGeneral();
    }

    const fields = recFields;
    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !recQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
