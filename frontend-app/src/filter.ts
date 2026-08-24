/**
 * OGC Filter Encoding builder for the attribute-filter UI. Sent as the WMS
 * `filter` GetMap parameter — orthogonal to STYLES/SLD_BODY (see legend.ts),
 * so an attribute filter and a recolored/hidden-class legend combine freely
 * on the same request.
 */

export type FilterOp = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'like'

export interface FilterCondition {
  column: string
  op: FilterOp
  value: string
}

/** How multiple conditions on the same layer combine: all of them, or any of them. */
export type FilterLogic = 'and' | 'or'

export const OP_LABELS: Record<FilterOp, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  like: 'enthält',
}

export const NUMERIC_OPS: FilterOp[] = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte']
export const TEXT_OPS: FilterOp[] = ['eq', 'neq', 'like']

const OP_TAG: Record<Exclude<FilterOp, 'like'>, string> = {
  eq: 'PropertyIsEqualTo',
  neq: 'PropertyIsNotEqualTo',
  gt: 'PropertyIsGreaterThan',
  lt: 'PropertyIsLessThan',
  gte: 'PropertyIsGreaterThanOrEqualTo',
  lte: 'PropertyIsLessThanOrEqualTo',
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function conditionXml(c: FilterCondition): string {
  const prop = `<ogc:PropertyName>${escapeXml(c.column)}</ogc:PropertyName>`
  if (c.op === 'like') {
    return (
      '<ogc:PropertyIsLike wildCard="*" singleChar="." escapeChar="!">' +
      prop + `<ogc:Literal>*${escapeXml(c.value)}*</ogc:Literal></ogc:PropertyIsLike>`
    )
  }
  const tag = OP_TAG[c.op]
  return `<ogc:${tag}>${prop}<ogc:Literal>${escapeXml(c.value)}</ogc:Literal></ogc:${tag}>`
}

/**
 * The condition XML, without the enclosing <ogc:Filter> — for splicing into
 * an SLD Rule's own filter (see legend.ts), since MapServer rejects the
 * standalone FILTER parameter combined with SLD/SLD_BODY. `logic` decides
 * whether conditions combine with AND (all must match) or OR (any matches).
 * null when there's nothing to filter on (all conditions cleared).
 */
export function buildConditionsXml(conditions: FilterCondition[], logic: FilterLogic = 'and'): string | null {
  const usable = conditions.filter((c) => c.column && c.value.trim() !== '')
  if (usable.length === 0) return null
  const parts = usable.map(conditionXml)
  if (parts.length === 1) return parts[0]
  const tag = logic === 'or' ? 'Or' : 'And'
  return `<ogc:${tag}>${parts.join('')}</ogc:${tag}>`
}

/** The standalone WMS `filter` GetMap parameter — only usable when no SLD_BODY is also being sent. */
export function buildFilterXml(conditions: FilterCondition[], logic: FilterLogic = 'and'): string | null {
  const inner = buildConditionsXml(conditions, logic)
  return inner ? `<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc">${inner}</ogc:Filter>` : null
}
