import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { openWorkspace } from '../desktop/workspace-fixture.ts'

// From the repository root, build the renderer and run:
// node app/tests/interface/review/git.integration.ts
const applicationRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'diffpane-git-integration-')))
const repository = path.join(directory, 'project')
const profile = path.join(directory, 'profile')
const scattered = 'src/scattered.txt'
const staged = 'src/staged.txt'
const untracked = 'src/untracked file.txt'
const cancelled = 'src/cancelled.txt'
const dayCancelled = 'src/day-cancelled.txt'
const branchFile = 'src/branch-note.txt'
const mainFile = 'src/main-note.txt'
const gitPanel = '#git-workspace'
const gitToggle = '#git-workspace-toggle'
const slider = `${gitPanel} [role="slider"][aria-label="Change map"]`
const reviewQueue = '#change-review'

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
}
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repository, ...args], { env: gitEnv, encoding: 'utf8' }).trimEnd()
const write = (file: string, data: string) => writeFileSync(path.join(repository, file), data)
const head = () => git('rev-parse', 'HEAD')

function createFixture() {
  mkdirSync(path.join(repository, 'src'), { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Diffpane Test')
  git('config', 'user.email', 'diffpane@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const at = (hour: number, minute: number) => new Date(midnight).setHours(hour, minute, 0, 0)
  const dated = (timestamp: number, ...args: string[]) => {
    const date = new Date(timestamp).toISOString()
    execFileSync('git', ['-C', repository, ...args], {
      env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
    return head()
  }
  const commit = (timestamp: number, message: string) => {
    git('add', '.')
    return dated(timestamp, 'commit', '-qm', message)
  }

  const baseLines = Array.from({ length: 115 }, (_, index) => `context line ${index + 1}`)
  write(scattered, `${baseLines.join('\n')}\n`)
  write(cancelled, 'unchanged in the working tree\n')
  write(dayCancelled, 'unchanged by the day’s commits\n')
  const base = commit(midnight.getTime() - 1000, 'Last commit before midnight')

  git('switch', '-qc', 'review/change-map')
  write(branchFile, 'feature branch came first\nfeature branch line two\n')
  write(dayCancelled, 'temporary committed churn\n')
  const branch = commit(at(8, 5), 'Feature commit before merge')

  git('switch', '-q', 'main')
  write(mainFile, 'main contributed this line\n')
  const main = commit(at(8, 20), 'Main commit before merge')
  write('src/diverged.txt', 'main tip after the merge base\n')
  const mainTip = commit(at(18, 0), 'Main-only commit outside HEAD')
  git('switch', '-q', 'review/change-map')
  const merge = dated(at(12, 15), 'merge', '-q', '--no-ff', '-m', 'Merge incoming main commit', main)
  write(dayCancelled, 'unchanged by the day’s commits\n')
  const current = commit(at(17, 20), 'Cancel today’s temporary churn')
  git('tag', 'review-demo', current)

  write(staged, 'staged line one\nstaged line two\n')
  write(cancelled, 'unchanged in the working tree\nstaged line cancelled on disk\n')
  git('add', staged, cancelled)
  write(cancelled, 'unchanged in the working tree\n')
  const workingLines = baseLines.flatMap((line, index) => {
    if (index === 11) return ['replacement in working tree']
    if (index === 54) return ['standalone inserted work', line]
    if (index === 92) return []
    return [line]
  })
  write(scattered, `${workingLines.join('\n')}\n`)
  write(untracked, 'untracked line one\nuntracked line two\n')
  return { base, branch, main, mainTip, merge, current }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const rendererErrors: string[] = []
let page: Page

async function until<T>(description: string, read: () => Promise<T>, remaining = 160): Promise<T> {
  if (remaining === 0) throw new Error(`Timed out waiting for ${description}.`)
  const value = await read()
  if (value) return value
  await delay(125)
  return until(description, read, remaining - 1)
}

function evaluate(expression: string): Promise<unknown> {
  return page.evaluate(expression)
}

const select = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`
const matches = async (expression: string) => (await evaluate(expression)) === true
const visible = (selector: string) => matches(`Boolean(${select(selector)}?.getClientRects().length)`)
const exists = (selector: string) => matches(`Boolean(${select(selector)})`)
const content = async (selector: string) => {
  const value = await evaluate(`${select(selector)}?.textContent ?? ''`)
  assert.ok(typeof value === 'string')
  return value
}
const attribute = (selector: string, name: string) =>
  evaluate(`${select(selector)}?.getAttribute(${JSON.stringify(name)}) ?? null`)
const gitFile = (name: string) => `${gitPanel} [data-git-file="${name}"]`
const gitCommit = (sha: string) => `${gitPanel} [data-git-commit="${sha}"]`
const gitHour = (sha: string) => `${gitPanel} button[data-git-hour-target="${sha}"]`
const reviewFile = (name: string) => `${reviewQueue} .change-review-row[data-path="${name}"]`
const reviewFilter = (filter: 'modified' | 'added') => `${reviewQueue} [data-filter="${filter}"]`

async function click(selector: string) {
  await until(selector, () => visible(selector))
  await evaluate(`${select(selector)}.click()`)
}

async function button(container: string, name: string) {
  const buttons = `Array.from(document.querySelectorAll(${JSON.stringify(`${container} button`)}))`
  const target = `${buttons}.find(button => button.getClientRects().length
    && !button.disabled && (button.getAttribute('aria-label') ?? button.textContent.trim()) === ${JSON.stringify(name)})`
  await until(`button ${name}`, () => matches(`Boolean(${target})`))
  await evaluate(`${target}.click()`)
}

async function pick(name: string, value: string) {
  const options = `Array.from(document.querySelectorAll(${JSON.stringify(`${gitPanel} select`)}))`
  const target = `${options}.find(select => (select.getAttribute('aria-label') ?? select.labels?.[0]?.textContent.trim()) === ${JSON.stringify(name)}
    && Array.from(select.options).some(option => option.value === ${JSON.stringify(value)}))`
  await until(`${name} option ${value}`, () => matches(`Boolean(${target})`))
  await evaluate(`(() => {
    const control = ${target}
    control.value = ${JSON.stringify(value)}
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

async function counts(added: number, removed: number) {
  await until(`${added} added and ${removed} removed`, async () => {
    const result = await content(`${gitPanel} .git-line-totals`)
    return result.match(new RegExp(`\\+${added}(?!\\d)\\D*[−-]${removed}(?!\\d)`))
  })
}

async function reviewCounts(modified: number, added: number) {
  await until(`${modified} modified and ${added} added files in the review queue`, async () => {
    return (
      (await content(`${reviewFilter('modified')} span`)) === String(modified) &&
      (await content(`${reviewFilter('added')} span`)) === String(added)
    )
  })
}

async function hunkAt(index: number) {
  await until(`hunk ${index} of 3`, async () => {
    return (
      (await attribute(slider, 'aria-valuenow')) === String(index) && (await attribute(slider, 'aria-valuemax')) === '3'
    )
  })
}

async function key(selector: string, value: string) {
  await evaluate(`(() => {
    const control = ${select(selector)}
    control.focus()
    control.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(value)}, bubbles: true, cancelable: true }))
  })()`)
}

async function clickLastOriginalMark() {
  const mark = `${gitPanel} .review-map-row.is-original .review-map-mark:last-child`
  await until('the original-side change mark', () => visible(mark))
  const point = await evaluate(`(() => {
    const element = ${select(mark)}
    const rect = element.getBoundingClientRect()
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}
  })()`)
  assert.ok(isRecord(point) && typeof point.x === 'number' && typeof point.y === 'number')
  await page.mouse.click(point.x, point.y)
}

async function seesPatch(text: string) {
  await until(`patch line "${text}"`, () =>
    matches(`Array.from(document.querySelectorAll(${JSON.stringify(`${gitPanel} .monaco-diff-editor .view-line`)}))
        .some(line => line.textContent.replace(/\\s/g, ' ').includes(${JSON.stringify(text)}))`),
  )
}

async function oneSidedChange(side: 'working' | 'original', range: string) {
  const source = `${gitPanel} .review-map-row.is-${side}`
  const other = side === 'working' ? 'original' : 'working'
  await until(`change mark on the ${side} side`, () => visible(`${source} .review-map-mark`))
  assert.equal(await content(`${source} .review-map-row-range`), range)
  assert.equal(await exists(`${gitPanel} .review-map-row.is-${other} .review-map-mark`), false)
}

async function screenshot(name: string) {
  const destination = process.env.DIFFPANE_GIT_TEST_SCREENSHOTS
  if (!destination) return
  mkdirSync(destination, { recursive: true })
  await page.screenshot({ path: path.join(destination, `git-workspace-${name}.png`) })
}

function viewport(width: number, height: number) {
  return page.setViewportSize({ width, height })
}

async function run(fixture: ReturnType<typeof createFixture>) {
  const originalIndex = git('ls-files', '-s')
  await viewport(1280, 900)
  await until('the fixture’s nested workspace', async () => (await content('#project-name')) === 'src')
  await click(gitToggle)
  await until('the Git workspace', () => visible(gitPanel))
  await counts(6, 2)
  await until('today’s current HEAD', () => visible(gitCommit(fixture.current)))
  assert.ok(await visible(`${gitFile(scattered)} .git-bar-removed`))
  assert.equal(await attribute(`${gitFile(scattered)} .git-bar-removed`, 'style'), 'inline-size: 100%;')
  assert.equal(await attribute(`${gitFile(staged)} .git-bar-added`, 'style'), 'inline-size: 100%;')

  await Promise.all(
    [fixture.current, fixture.merge, fixture.main, fixture.branch].map(async sha => {
      assert.ok(await visible(gitCommit(sha)), `Expected Today to include ${sha}`)
    }),
  )
  await Promise.all(
    [fixture.base, fixture.mainTip].map(async sha => {
      assert.equal(await exists(gitCommit(sha)), false, `Expected Today to exclude ${sha}`)
    }),
  )
  const hourTargets = await evaluate(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${gitPanel} button[data-git-hour-target]`)}), hour => hour.dataset.gitHourTarget)`,
  )
  assert.deepEqual(hourTargets, [fixture.main, fixture.merge, fixture.current])
  assert.equal(await exists(gitFile(cancelled)), false)
  assert.ok(await visible(gitFile(staged)))
  assert.ok(await visible(gitFile(untracked)))
  await click(gitFile(untracked))
  await seesPatch('untracked line two')

  await pick('Comparison', 'staged')
  await counts(3, 0)
  assert.ok(await visible(gitFile(cancelled)))
  await click(gitFile(cancelled))
  await seesPatch('staged line cancelled on disk')
  assert.equal(await exists(gitFile(untracked)), false)

  await pick('Comparison', 'unstaged')
  await counts(4, 3)
  assert.ok(await visible(gitFile(untracked)))
  assert.equal(await exists(gitFile(staged)), false)
  await click(gitFile(cancelled))
  await seesPatch('staged line cancelled on disk')

  await pick('Comparison', 'head')
  await counts(6, 2)
  await click(gitFile(scattered))
  await hunkAt(1)
  await seesPatch('replacement in working tree')
  await screenshot('today')
  await button(gitPanel, 'Full file')
  assert.equal(await attribute(`${gitPanel} .git-diff`, 'data-review-scope'), 'full')
  await button(gitPanel, 'Changes only')
  assert.equal(await attribute(`${gitPanel} .git-diff`, 'data-review-scope'), 'focus')
  await button(gitPanel, 'Replay change')
  await until('the standalone change replay', () => visible('dialog.change-replay[open]'))
  await button('dialog.change-replay', 'Close replay')
  await click(`${gitPanel} .review-hunk-next`)
  await hunkAt(2)
  await seesPatch('standalone inserted work')
  await key(slider, 'Home')
  await hunkAt(1)
  await clickLastOriginalMark()
  await hunkAt(3)
  await seesPatch('context line 93')
  await click(`${gitPanel} .review-hunk-prev`)
  await hunkAt(2)

  const focusDiff = `${gitPanel} .git-diff-focus`
  await button(gitPanel, 'Focus diff')
  assert.equal(await attribute(focusDiff, 'aria-pressed'), 'true')
  assert.equal(await visible(`${gitPanel} .git-activity`), false)
  assert.equal(await visible(`${gitPanel} .git-file-list`), false)
  await hunkAt(2)
  await screenshot('focused')
  await key(focusDiff, 'Escape')
  assert.equal(await attribute(focusDiff, 'aria-pressed'), 'false')
  assert.ok(await visible(gitFile(scattered)))
  assert.ok(await visible(`${gitPanel} .git-activity`))
  await hunkAt(2)

  const changed = readFileSync(path.join(repository, scattered), 'utf8')
  write(scattered, changed.replace('standalone inserted work', 'updated work at the same hunk'))
  await seesPatch('updated work at the same hunk')
  await hunkAt(2)
  write(staged, 'staged line one\nstaged line two\nlive line from disk\n')
  await counts(7, 2)
  assert.equal(await attribute(gitFile(scattered), 'aria-pressed'), 'true')
  await hunkAt(2)
  await seesPatch('updated work at the same hunk')
  await click(gitFile(staged))
  await seesPatch('live line from disk')

  const outsideScope = 'outside-scope.txt'
  write(outsideScope, 'created above the open folder\n')
  await counts(8, 2)
  await click(gitFile(outsideScope))
  await seesPatch('created above the open folder')
  write(outsideScope, 'updated above the open folder\n')
  await seesPatch('updated above the open folder')
  rmSync(path.join(repository, outsideScope))
  await counts(7, 2)
  assert.equal(await exists(gitFile(outsideScope)), false)

  const deletedPath = path.join(repository, dayCancelled)
  const deleted = readFileSync(deletedPath, 'utf8')
  rmSync(deletedPath)
  await counts(7, 3)
  await click(gitFile(dayCancelled))
  await seesPatch('unchanged by the day’s commits')
  await oneSidedChange('original', 'Line 1')
  write(dayCancelled, deleted)
  await counts(7, 2)

  await click(gitHour(fixture.main))
  assert.equal(await attribute(gitCommit(fixture.main), 'aria-pressed'), 'true')
  assert.equal(await attribute(gitHour(fixture.main), 'aria-current'), 'true')
  assert.ok(await matches(`document.activeElement === ${select(gitCommit(fixture.main))}`))
  await counts(1, 0)
  await seesPatch('main contributed this line')
  await screenshot('today-timeline')

  await button(gitPanel, 'Compare day')
  await counts(3, 0)
  const comparison = await content(gitPanel)
  assert.ok(comparison.includes(fixture.base.slice(0, 7)), 'Compare day identifies the pre-midnight baseline')
  assert.equal(await exists(gitFile(dayCancelled)), false, 'Day comparison reports net changes')
  assert.equal(await exists(gitFile(staged)), false, 'Day comparison excludes the working tree')
  await click(gitFile(branchFile))
  await seesPatch('feature branch came first')

  await button(gitPanel, 'History')
  await until('the diverged main branch tip', () => visible(gitCommit(fixture.mainTip)))
  assert.ok(await visible(`${gitCommit(fixture.mainTip)} [data-git-ref="main"]`))
  assert.ok(await visible(`${gitCommit(fixture.current)} [data-git-ref="review/change-map"]`))
  assert.ok(await visible(`${gitCommit(fixture.current)} [data-git-ref="review-demo"]`))
  assert.ok(await exists(`${gitPanel} [data-git-edge-from="working"][data-git-edge-to="${fixture.current}"]`))
  await Promise.all(
    [fixture.branch, fixture.main].map(async parent => {
      assert.ok(await exists(`${gitPanel} [data-git-edge-from="${fixture.merge}"][data-git-edge-to="${parent}"]`))
    }),
  )
  const graphOrder = await evaluate(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${gitPanel} [data-git-commit]`)})).map(row => row.dataset.gitCommit)`,
  )
  assert.ok(Array.isArray(graphOrder))
  assert.ok(graphOrder.indexOf(fixture.merge) < graphOrder.indexOf(fixture.branch))
  assert.ok(graphOrder.indexOf(fixture.merge) < graphOrder.indexOf(fixture.main))
  await click(gitCommit(fixture.merge))
  await counts(1, 0)
  await click(gitFile(mainFile))
  await seesPatch('main contributed this line')
  await oneSidedChange('working', 'Line 1')
  await screenshot('history')
  await viewport(650, 900)
  await until('the activity rail stacks above the inspector at minimum width', () =>
    matches(`(() => {
      const activity = ${select(`${gitPanel} .git-activity`)}.getBoundingClientRect()
      const inspector = ${select(`${gitPanel} .git-inspector`)}.getBoundingClientRect()
      return activity.width === inspector.width && activity.bottom === inspector.top
    })()`),
  )
  await until('inline Git diff at desktop minimum width', () =>
    visible(`${gitPanel} .monaco-diff-editor:not(.side-by-side)`),
  )
  await screenshot('history-narrow')
  await viewport(1280, 900)
  await pick('Compare parent', fixture.main)
  await counts(3, 1)
  await click(gitFile(branchFile))
  await seesPatch('feature branch line two')

  await click(gitCommit(fixture.mainTip))
  await counts(1, 0)
  await click(gitFile('src/diverged.txt'))
  await seesPatch('main tip after the merge base')
  await button(gitPanel, 'Today')
  await counts(7, 2)
  assert.equal(await exists(gitCommit(fixture.mainTip)), false)
  await key(`${gitPanel} [data-git-view="today"]`, 'Escape')
  assert.equal(await visible(gitPanel), false)
  assert.equal(await attribute(gitToggle, 'aria-pressed'), 'false')
  await click(gitToggle)
  await counts(7, 2)
  await button(gitPanel, 'Review changes')
  await until('the existing Changes queue', () => visible(reviewQueue))
  assert.equal(await visible(gitPanel), false)
  await reviewCounts(2, 2)
  assert.equal(await attribute(reviewFilter('modified'), 'aria-pressed'), 'true')
  assert.equal(await exists(reviewFile(staged)), false)
  assert.equal(await exists(reviewFile(untracked)), false)
  await click(reviewFile(scattered))
  await until('the existing review editor', () => visible('.workbench .monaco-diff-editor'))
  await button(reviewQueue, 'Mark reviewed & next')
  await until('the reviewed file remains in Modified', () => visible(`${reviewFile(scattered)}[data-reviewed="true"]`))
  await until('the next Modified file opens', () => visible(`${reviewFile(cancelled)}[aria-selected="true"]`))
  const reviewProgress = `${reviewQueue} .change-review-progress-announcement`
  assert.equal(await content(reviewProgress), '1 of 4 reviewed')

  await button(reviewQueue, 'Added')
  assert.equal(await attribute(reviewFilter('added'), 'aria-pressed'), 'true')
  await until('the staged and untracked additions', async () => {
    return (await visible(reviewFile(staged))) && (await visible(reviewFile(untracked)))
  })
  assert.equal(await exists(reviewFile(scattered)), false)
  assert.equal(await content(reviewProgress), '1 of 4 reviewed')

  await button(reviewQueue, 'Modified')
  await click(reviewFile(scattered))
  await button(reviewQueue, 'Undo review')
  assert.equal(await attribute(reviewFile(scattered), 'data-reviewed'), 'false')
  assert.equal(await content(reviewProgress), '0 of 4 reviewed')
  await reviewCounts(2, 2)

  await button(reviewQueue, 'Capture checkpoint')
  await until('an unchanged checkpoint', async () => {
    return (await content(`${reviewQueue} .change-review-empty h3`)) === 'No changes since checkpoint'
  })
  const checkpointAddition = 'src/checkpoint-addition.txt'
  write(checkpointAddition, 'added after the checkpoint\n')
  await reviewCounts(0, 1)
  assert.equal(await attribute(reviewFilter('added'), 'aria-pressed'), 'true')
  await until('the new checkpoint file', () => visible(reviewFile(checkpointAddition)))
  assert.equal(await exists(reviewFile(staged)), false)
  await button(reviewQueue, 'Modified')
  assert.equal(await content(`${reviewQueue} .change-review-empty h3`), 'No modified files')

  assert.equal(head(), fixture.current, 'Inspection leaves HEAD in place')
  assert.equal(git('ls-files', '-s'), originalIndex, 'Inspection leaves the Git index in place')
  assert.deepEqual(rendererErrors, [], 'Inspecting changes does not raise renderer exceptions')
}

try {
  const fixture = createFixture()
  const workspace = await openWorkspace(applicationRoot, profile, path.join(repository, 'src'), error =>
    rendererErrors.push(error.message),
  )
  page = workspace.page
  try {
    await run(fixture)
    console.info('Git workspace integration passed.')
  } finally {
    await workspace.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
}
