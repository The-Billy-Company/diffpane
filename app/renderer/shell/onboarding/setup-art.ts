// Copyright (c) 2026 The Billy Company
export const appIcon = `${import.meta.env.BASE_URL}img/diffpane.png`

export function introArt() {
  return `<div class="onboarding-intro-field" aria-hidden="true">
    <div class="onboarding-intro-sheet onboarding-intro-sheet--before">
      <span></span><span>−</span><span>−</span><span></span><span></span><span></span>
    </div>
    <div class="onboarding-intro-sheet onboarding-intro-sheet--after">
      <span></span><span>+</span><span>+</span><span></span><span></span><span></span>
    </div>
  </div>`
}

function line(number: string, content: string, change?: 'removed' | 'added') {
  const glyph = change === 'removed' ? '−' : change === 'added' ? '+' : ''
  return `<div class="onboarding-code-line"${change ? ` data-change="${change}"` : ''}>
    <span>${number}</span><span>${glyph}</span><code>${content}</code>
  </div>`
}

export function comparisonArt() {
  const commentLine = line('1', '<em>// Watch edits</em>')
  const blankLine = line('2', '')
  const beforeLine = line('3', 'watch(<mark>false</mark>)', 'removed')
  const afterLine = line('3', 'watch(<mark>true</mark>)', 'added')
  const startLine = line('4', 'start()')

  return `<div class="onboarding-preview-window" aria-hidden="true">
    <div class="onboarding-preview-titlebar">
      <span class="onboarding-preview-traffic"><i></i><i></i><i></i></span>
      <span>studio</span>
      <span class="onboarding-preview-branch">⑂ main</span>
    </div>
    <div class="onboarding-preview-body">
      <div class="onboarding-preview-explorer">
        <div>EXPLORER</div>
        <div class="onboarding-preview-folder">⌄ src</div>
        <div class="onboarding-preview-file onboarding-preview-file--selected"><i>TS</i> watch.ts <small>M</small></div>
        <div class="onboarding-preview-file"><i>TS</i> review.ts</div>
        <div class="onboarding-preview-file onboarding-preview-file--root"><i>≡</i> README.md</div>
      </div>
      <div class="onboarding-preview-editor">
        <div class="onboarding-preview-tabs">
          <span><i>TS</i> watch.ts</span>
          <span class="onboarding-preview-count"><b>+1</b><b>−1</b></span>
        </div>
        <div class="onboarding-code onboarding-code--split">
          <div><div class="onboarding-code-caption">Git HEAD</div>${commentLine}${blankLine}${beforeLine}${startLine}</div>
          <div><div class="onboarding-code-caption">Working tree</div>${commentLine}${blankLine}${afterLine}${startLine}</div>
        </div>
        <div class="onboarding-code onboarding-code--inline">
          <div class="onboarding-code-caption">Working tree</div>${commentLine}${blankLine}${beforeLine}${afterLine}${startLine}
        </div>
      </div>
    </div>
    <div class="onboarding-preview-status"><span>src/watch.ts</span><span>1 changed file</span></div>
  </div>`
}
