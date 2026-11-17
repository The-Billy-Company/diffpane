export const appIcon = `${import.meta.env.BASE_URL}img/diffpane.png`

export function introArt() {
  return `<div class="onboarding-intro-field" aria-hidden="true">
    <div class="onboarding-intro-sheet onboarding-intro-sheet--before">
      <span></span><span></span><span>−</span><span>−</span><span></span><span></span><span>−</span><span></span>
    </div>
    <div class="onboarding-intro-sheet onboarding-intro-sheet--after">
      <span></span><span>+</span><span>+</span><span></span><span></span><span>+</span><span></span><span></span>
    </div>
  </div>`
}

const codeBefore = '<b>const</b> mode = <em>"once"</em>'
const codeAfter = '<b>const</b> mode = <em>"live"</em>'
const codeFirst = '<b>const</b> base = <em>"HEAD"</em>'
const codeLast = 'review(base, mode)'

function line(number: string, content: string, change?: 'removed' | 'added') {
  const glyph = change === 'removed' ? '−' : change === 'added' ? '+' : ''
  return `<div class="onboarding-code-line"${change ? ` data-change="${change}"` : ''}>
    <span>${number}</span><span>${glyph}</span><code>${content}</code>
  </div>`
}

export function comparisonArt() {
  return `<div class="onboarding-preview-window" aria-hidden="true">
    <div class="onboarding-preview-titlebar">
      <span class="onboarding-preview-traffic"><i></i><i></i><i></i></span>
      <span>studio-workspace</span>
      <span class="onboarding-preview-branch">⑂ main</span>
    </div>
    <div class="onboarding-preview-body">
      <div class="onboarding-preview-explorer">
        <div>FILES</div>
        <div class="onboarding-preview-root">⌄ studio</div>
        <div class="onboarding-preview-folder">⌄ src</div>
        <div class="onboarding-preview-file onboarding-preview-file--selected"><i>TS</i> workspace.ts <small>M</small></div>
        <div class="onboarding-preview-file"><i>TS</i> review.ts</div>
        <div class="onboarding-preview-file onboarding-preview-file--root"><i>≡</i> README.md</div>
      </div>
      <div class="onboarding-preview-editor">
        <div class="onboarding-preview-tabs"><span><i>TS</i> workspace.ts</span><span class="onboarding-preview-count"><b>+1</b><b>−1</b></span></div>
        <div class="onboarding-code onboarding-code--split">
          <div><div class="onboarding-code-caption">Before</div>${line('1', codeFirst)}${line('2', '')}${line('3', codeBefore, 'removed')}${line('4', codeLast)}</div>
          <div><div class="onboarding-code-caption">Working tree</div>${line('1', codeFirst)}${line('2', '')}${line('3', codeAfter, 'added')}${line('4', codeLast)}</div>
        </div>
        <div class="onboarding-code onboarding-code--inline">
          <div class="onboarding-code-caption">Working tree</div>${line('1', codeFirst)}${line('2', '')}${line('3', codeBefore, 'removed')}${line('3', codeAfter, 'added')}${line('4', codeLast)}
        </div>
      </div>
    </div>
    <div class="onboarding-preview-status"><i></i> Watching studio <span>1 changed file</span></div>
  </div>`
}

export function postcardArt() {
  return `<div class="onboarding-postcard" aria-hidden="true">
    <div class="onboarding-postcard-note">
      <div>Happy reviewing!</div>
      <p>See you in the working tree.</p>
      <span class="onboarding-postcard-lines"><i></i><i></i><i></i></span>
    </div>
    <div class="onboarding-postcard-address">
      <div class="onboarding-postcard-stamp"><img src="${appIcon}" alt=""></div>
      <span>DIFFPANE</span>
      <span class="onboarding-postcard-postmark"><i></i><i></i><i></i></span>
    </div>
  </div>`
}
