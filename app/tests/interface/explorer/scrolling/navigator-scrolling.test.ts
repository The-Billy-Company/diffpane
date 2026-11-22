import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
import { createServer } from 'vite-plus'
import { test } from 'vite-plus/test'
import type { TestContext } from 'vite-plus/test'
import type { NavigatorCoverage, NavigatorViewport } from './navigator-scrolling-fixture.ts'

const route = '/__navigator-scrolling__'

async function openNavigator(t: TestContext) {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../../../../../vite.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'navigator-scrolling-fixture',
        configureServer(instance) {
          instance.middlewares.use(route, (_request, response) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(`<!doctype html>
<html><head><style>
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; }
  #navigator { width: 340px; height: 500px; font-family: Arial, sans-serif; --text-body: 14px; --text-caption: 12px; }
</style></head><body>
  <div id="navigator"></div>
  <script type="module" src="/tests/interface/explorer/scrolling/navigator-scrolling-fixture.ts"></script>
</body></html>`)
          })
        },
      },
    ],
  })
  t.onTestFinished(() => server.close())
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  assert.ok(url, 'The explorer fixture server should provide a local URL.')
  const browser = await webkit.launch()
  t.onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 500, height: 600 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(new URL(route, url).href)
  await page.waitForFunction(() => globalThis.window.navigatorScrollingFixture?.ready(), undefined, { timeout: 10_000 })
  return { page, errors }
}

test(
  'inventory insertions preserve the first visible explorer row and pixel offset near the bottom',
  { timeout: 30_000 },
  async t => {
    const { page, errors } = await openNavigator(t)
    await page.evaluate(() => globalThis.window.navigatorScrollingFixture.scrollNearBottom())
    await page.waitForFunction(
      () => {
        const { window } = globalThis
        try {
          return window.navigatorScrollingFixture.viewport().offset === 7
        } catch {
          return false
        }
      },
      undefined,
      { timeout: 10_000 },
    )
    const before = await page.evaluate<NavigatorViewport>(() => globalThis.window.navigatorScrollingFixture.viewport())
    assert.ok(before.scrollHeight - before.clientHeight - before.scrollTop < before.clientHeight)

    await page.evaluate(() => globalThis.window.navigatorScrollingFixture.insertEarlierFiles())
    await page.waitForFunction(() => globalThis.window.navigatorScrollingFixture.ready(), undefined, {
      timeout: 10_000,
    })
    const after = await page.evaluate<NavigatorViewport>(() => globalThis.window.navigatorScrollingFixture.viewport())
    assert.equal(after.path, before.path, 'New files above the viewport should leave the same file at the top.')
    assert.equal(after.offset, before.offset, 'A partially visible row should retain its exact pixel offset.')
    assert.ok(after.scrollHeight > before.scrollHeight)
    assert.deepEqual(errors, [], 'Rendering and refreshing the explorer should not raise browser errors.')
  },
)

test(
  'the change map replaces the native scrollbar without relying on scrollbar-width',
  { timeout: 30_000 },
  async t => {
    const { page, errors } = await openNavigator(t)
    await page.addStyleTag({ content: '.navigator-tree { scrollbar-width: auto !important; }' })
    const gutter = await page.evaluate(() => globalThis.window.navigatorScrollingFixture.scrollbarGutter())
    assert.ok(gutter > 0, 'The native scrollbar should reserve a gutter when the change map is hidden.')

    await page.evaluate(() => globalThis.window.navigatorScrollingFixture.showChanges(true))
    await page.locator('.navigator-change-rail').waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(
      await page.evaluate(() => globalThis.window.navigatorScrollingFixture.scrollbarGutter()),
      0,
      'The WebKit scrollbar fallback should remove the native gutter while the map is visible.',
    )

    await page.evaluate(() => globalThis.window.navigatorScrollingFixture.showChanges(false))
    await page.locator('.navigator-change-rail').waitFor({ state: 'hidden', timeout: 10_000 })
    assert.equal(await page.evaluate(() => globalThis.window.navigatorScrollingFixture.scrollbarGutter()), gutter)
    assert.deepEqual(errors, [], 'Updating the change map should not raise browser errors.')
  },
)

test(
  'fast scrolling keeps rows ready before the next render with a bounded mounted range',
  { timeout: 30_000 },
  async t => {
    const { page, errors } = await openNavigator(t)
    for (const direction of [1, -1]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Settle each scroll direction before testing its synchronous jump.
      const coverage = await page.evaluate<NavigatorCoverage, number>(async scrollDirection => {
        const { window, requestAnimationFrame } = globalThis
        window.navigatorScrollingFixture.scrollToMiddle()
        await new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
        // Check the same task as the scroll assignment, before the render callback can run.
        return window.navigatorScrollingFixture.jumpBeforeRender(scrollDirection)
      }, direction)
      assert.equal(
        coverage.covered,
        true,
        `The viewport should remain filled while scrolling ${direction > 0 ? 'down' : 'up'}.`,
      )
      assert.ok(
        coverage.mountedRows <= coverage.viewportRows * 5 + 1,
        'Mounted rows should stay bounded by the viewport.',
      )
    }
    assert.deepEqual(errors, [], 'Scrolling the explorer should not raise browser errors.')
  },
)
