const WORD_START = /[\p{ID_Start}$_]/u
const WORD_PART = /[\p{ID_Continue}$\u200c\u200d]/u
const NUMBER_AT = /(?:0[xXbBoO][0-9a-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y
const LINE_BREAK = /[\n\r\u2028\u2029]/
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])
const CONDITION_KEYWORDS = new Set(['if', 'while', 'for', 'with'])

function isLineBreak(ch) {
  return LINE_BREAK.test(ch)
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\u00a0' || ch === '\ufeff' || (ch > '\u007f' && /\s/.test(ch))
}

function regexLiteralEnd(text, start) {
  let inClass = false
  let j = start + 1
  while (j < text.length) {
    const ch = text[j]
    if (isLineBreak(ch)) return -1
    if (ch === '\\') {
      j += 2
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
    } else if (ch === '[') {
      inClass = true
    } else if (ch === '/') {
      j += 1
      while (j < text.length && WORD_PART.test(text[j])) j += 1
      return j
    }
    j += 1
  }
  return -1
}

function quotedEnd(text, start) {
  const quote = text[start]
  let j = start + 1
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === quote) return j + 1
    if (isLineBreak(ch)) return j
    j += 1
  }
  return text.length
}

function templateSegmentEnd(text, start) {
  let j = start
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '`') return { end: j + 1, opensExpression: false }
    if (ch === '$' && text[j + 1] === '{') return { end: j + 2, opensExpression: true }
    j += 1
  }
  return { end: text.length, opensExpression: false }
}

export function tokenize(text) {
  const tokens = []
  const comments = []
  const nesting = []
  const parens = []
  const n = text.length
  let i = 0
  let newlineBefore = false
  let regexAllowed = true
  let lastWord = ''

  const emit = (kind, start, end) => {
    tokens.push({ kind, text: text.slice(start, end), start, end, nl: newlineBefore })
    newlineBefore = false
  }

  if (text.startsWith('#!')) {
    let end = 0
    while (end < n && !isLineBreak(text[end])) end += 1
    comments.push({ kind: 'hashbang', start: 0, end, text: text.slice(0, end) })
    i = end
  }

  while (i < n) {
    const ch = text[i]
    const next = text[i + 1]

    if (isLineBreak(ch)) {
      newlineBefore = true
      i += 1
      continue
    }
    if (isSpace(ch)) {
      i += 1
      continue
    }

    if (ch === '/' && next === '/') {
      let end = i
      while (end < n && !isLineBreak(text[end])) end += 1
      comments.push({ kind: 'line', start: i, end, text: text.slice(i, end) })
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      const body = text.slice(i, end)
      if (/[\n\r\u2028\u2029]/.test(body)) newlineBefore = true
      comments.push({ kind: 'block', start: i, end, text: body })
      i = end
      continue
    }

    if (ch === '/' && regexAllowed) {
      const end = regexLiteralEnd(text, i)
      if (end > 0) {
        emit('regex', i, end)
        regexAllowed = false
        i = end
        continue
      }
    }

    if (ch === '"' || ch === "'") {
      const end = quotedEnd(text, i)
      emit('string', i, end)
      regexAllowed = false
      i = end
      continue
    }

    if (ch === '`' || (ch === '}' && nesting[nesting.length - 1] === 'template')) {
      if (ch === '}') nesting.pop()
      const segment = templateSegmentEnd(text, i + 1)
      emit('template', i, segment.end)
      if (segment.opensExpression) {
        nesting.push('template')
        regexAllowed = true
      } else {
        regexAllowed = false
      }
      i = segment.end
      continue
    }

    if (ch === '{') {
      nesting.push('brace')
      emit('punct', i, i + 1)
      regexAllowed = true
      i += 1
      continue
    }
    if (ch === '}') {
      nesting.pop()
      emit('punct', i, i + 1)
      regexAllowed = true
      i += 1
      continue
    }

    if (ch === '(') {
      parens.push(CONDITION_KEYWORDS.has(lastWord))
      emit('punct', i, i + 1)
      regexAllowed = true
      i += 1
      continue
    }
    if (ch === ')') {
      const conditional = parens.length > 0 && parens.pop()
      emit('punct', i, i + 1)
      regexAllowed = conditional
      i += 1
      continue
    }

    if (WORD_START.test(ch) || ch === '\\') {
      let end = i + 1
      while (end < n && WORD_PART.test(text[end])) end += 1
      const word = text.slice(i, end)
      emit('word', i, end)
      lastWord = word
      regexAllowed = REGEX_KEYWORDS.has(word)
      i = end
      continue
    }

    if (ch >= '0' && ch <= '9' || (ch === '.' && next >= '0' && next <= '9')) {
      NUMBER_AT.lastIndex = i
      const match = NUMBER_AT.exec(text)
      const end = match ? i + match[0].length : i + 1
      emit('number', i, end)
      regexAllowed = false
      i = end
      continue
    }

    if (ch === ']') {
      emit('punct', i, i + 1)
      regexAllowed = false
      i += 1
      continue
    }

    emit('punct', i, i + 1)
    regexAllowed = true
    i += 1
  }

  return { tokens, comments }
}
