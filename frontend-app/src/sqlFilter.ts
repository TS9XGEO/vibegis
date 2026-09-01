/**
 * Text <-> structured-filter bridge for AttributeFilter.tsx's SQL mode. Parses
 * a typed WHERE clause into the exact same `{ logic, conditions }` shape the
 * dropdown UI already builds (filter.ts) — a flat list of `column op value`
 * comparisons joined by one consistent AND or one consistent OR. No
 * parentheses, no mixed AND/OR, no IN/BETWEEN/NULL: deliberately small so
 * this plugs into the existing, already-safe buildCql()/buildFilterXml()
 * unchanged, rather than becoming a second query-building path to audit.
 *
 * Safety: the typed text is never concatenated into a query anywhere. The
 * tokenizer only recognizes a fixed grammar (quoted/escaped string or
 * numeric literals, a fixed operator set, bare-word identifiers) — anything
 * outside that (a semicolon, a comment, UNION/DROP/subqueries, an unmatched
 * quote) fails to tokenize at all. The parser then requires every identifier
 * to exactly match one of the layer's real, fetched columns. What comes out
 * is a plain FilterCondition[], serialized exactly like the visual builder's
 * own draft — there is no separate "run this SQL" path.
 */
import type { FilterCondition, FilterLogic, FilterOp } from './filter'

type Token =
  | { type: 'ident'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: string }
  | { type: 'op'; value: string }
  | { type: 'and' }
  | { type: 'or' }
  | { type: 'like' }

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]

    if (/\s/.test(ch)) {
      i++
      continue
    }

    if (ch === "'") {
      let j = i + 1
      let value = ''
      for (;;) {
        if (j >= text.length) throw new Error(`Nicht geschlossenes String-Literal ab Position ${i + 1}`)
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            value += "'"
            j += 2
            continue
          }
          j++
          break
        }
        value += text[j]
        j++
      }
      tokens.push({ type: 'string', value })
      i = j
      continue
    }

    const numMatch = /^-?\d+(\.\d+)?/.exec(text.slice(i))
    if (numMatch) {
      tokens.push({ type: 'number', value: numMatch[0] })
      i += numMatch[0].length
      continue
    }

    const twoChar = text.slice(i, i + 2)
    if (twoChar === '!=' || twoChar === '<>' || twoChar === '<=' || twoChar === '>=') {
      tokens.push({ type: 'op', value: twoChar })
      i += 2
      continue
    }
    if (ch === '=' || ch === '<' || ch === '>') {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }

    const wordMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))
    if (wordMatch) {
      const word = wordMatch[0]
      const upper = word.toUpperCase()
      if (upper === 'AND') tokens.push({ type: 'and' })
      else if (upper === 'OR') tokens.push({ type: 'or' })
      else if (upper === 'LIKE') tokens.push({ type: 'like' })
      else tokens.push({ type: 'ident', value: word })
      i += word.length
      continue
    }

    throw new Error(`Unerwartetes Zeichen '${ch}' an Position ${i + 1}`)
  }
  return tokens
}

const OP_TOKEN_TO_FILTER_OP: Record<string, FilterOp> = {
  '=': 'eq',
  '!=': 'neq',
  '<>': 'neq',
  '<': 'lt',
  '>': 'gt',
  '<=': 'lte',
  '>=': 'gte',
}

function parseCondition(group: Token[], validColumns: Set<string>): FilterCondition {
  if (group.length !== 3 || group[0].type !== 'ident') {
    throw new Error("Bedingung muss die Form 'spalte operator wert' haben")
  }
  const column = group[0].value
  if (!validColumns.has(column)) {
    throw new Error(`Unbekannte Spalte: '${column}'`)
  }

  const opToken = group[1]
  const literalToken = group[2]
  if (literalToken.type !== 'string' && literalToken.type !== 'number') {
    throw new Error(`Erwartete einen Wert (Zahl oder 'Text') nach '${column}'`)
  }

  let op: FilterOp
  let value = literalToken.value
  if (opToken.type === 'op') {
    op = OP_TOKEN_TO_FILTER_OP[opToken.value]
  } else if (opToken.type === 'like') {
    op = 'like'
    // cqlCondition()/conditionXml() already wrap the value in %…%/*…* —
    // stripping any wildcard the user typed keeps LIKE's "contains"
    // semantics identical to the visual builder instead of double-wrapping.
    value = value.replace(/^%+/, '').replace(/%+$/, '')
  } else {
    throw new Error(`Unbekannter Operator nach '${column}' — erlaubt: = != <> < > <= >= LIKE`)
  }

  return { column, op, value }
}

export function parseSqlWhere(text: string, validColumns: string[]): { logic: FilterLogic; conditions: FilterCondition[] } {
  const trimmed = text.trim()
  if (trimmed === '') return { logic: 'and', conditions: [] }

  const tokens = tokenize(trimmed)
  const validSet = new Set(validColumns)

  const groups: Token[][] = [[]]
  const connectives: FilterLogic[] = []
  for (const tok of tokens) {
    if (tok.type === 'and' || tok.type === 'or') {
      connectives.push(tok.type)
      groups.push([])
    } else {
      groups[groups.length - 1].push(tok)
    }
  }

  if (groups.some((g) => g.length === 0)) {
    throw new Error('Leere Bedingung — auf doppeltes UND/ODER oder ein fehlendes Ende prüfen')
  }
  const distinctConnectives = new Set(connectives)
  if (distinctConnectives.size > 1) {
    throw new Error('Gemischte UND/ODER-Verknüpfung wird nicht unterstützt — bitte einheitlich verwenden')
  }

  const logic: FilterLogic = connectives[0] ?? 'and'
  const conditions = groups.map((g) => parseCondition(g, validSet))
  return { logic, conditions }
}

function literalToSql(value: string): string {
  const numeric = value.trim() !== '' && !Number.isNaN(Number(value))
  return numeric ? value : `'${value.replace(/'/g, "''")}'`
}

const FILTER_OP_TO_SQL: Record<Exclude<FilterOp, 'like'>, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
}

/** Inverse of parseSqlWhere() — seeds the SQL-mode textarea from the visual builder's current draft. */
export function conditionsToSqlWhere(conditions: FilterCondition[], logic: FilterLogic): string {
  const usable = conditions.filter((c) => c.column && c.value.trim() !== '')
  if (usable.length === 0) return ''
  const parts = usable.map((c) => {
    const op = c.op === 'like' ? 'LIKE' : FILTER_OP_TO_SQL[c.op]
    return `${c.column} ${op} ${literalToSql(c.value)}`
  })
  return parts.join(logic === 'or' ? ' OR ' : ' AND ')
}
