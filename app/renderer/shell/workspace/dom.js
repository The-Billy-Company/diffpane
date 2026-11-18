/**
 * @template {Element} T
 * @param {ParentNode} parent
 * @param {string} selector
 * @param {abstract new (...args: never[]) => T} elementType
 */
export function requireElement(parent, selector, elementType) {
  const element = parent.querySelector(selector)
  if (!(element instanceof elementType)) {
    throw new Error(`Missing ${elementType.name} for ${selector}.`)
  }
  return element
}

/** @param {Element} parent @param {Element} child @param {Element} next */
function insertBeforeWithScroll(parent, child, next) {
  /** @type {{element: Element, left: number, top: number}[]} */
  const positions = []
  for (const element of [child, ...child.querySelectorAll('*')]) {
    const { scrollLeft: left, scrollTop: top } = element
    if (left || top) positions.push({ element, left, top })
  }
  parent.insertBefore(child, next)
  for (const { element, left, top } of positions) element.scrollTo({ left, top, behavior: 'instant' })
}

/**
 * @param {Element} parent
 * @param {readonly Element[]} children
 * @param {Element} anchor
 */
export function orderChildren(parent, children, anchor) {
  const move = typeof parent.moveBefore === 'function' ? parent.moveBefore.bind(parent) : null
  const active = parent.ownerDocument.activeElement
  const stationary = move
    ? undefined
    : (children.find(child => child.contains(active)) ?? children.find(child => child.querySelector('iframe')))
  let next = anchor
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]
    if (!child) continue
    if (child !== stationary && child.nextElementSibling !== next) {
      if (move) move(child, next)
      else insertBeforeWithScroll(parent, child, next)
    }
    next = child
  }
}
