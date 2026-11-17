import theme from 'material-icon-theme/dist/material-icons.json' with { type: 'json' }

interface IconTheme {
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  folderExpanded: string
  folder: string
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  file: string
  iconDefinitions: Record<string, { iconPath: string }>
}

const ICONS: IconTheme = theme
const ASSETS = import.meta.glob<string>('../../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
})
const LOCAL_ASSETS = import.meta.glob<string>('./file-icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
})

const FILE_NAMES = new Map([
  ['boxfile', 'boxfile'],
  ['zonefile', 'zoning'],
  ['.yamllint', 'yaml'],
  ['.yamllint.yml', 'yaml'],
  ['.yamllint.yaml', 'yaml'],
])
const FILE_EXTENSIONS = new Map([
  ['box', 'boxfile'],
  ['zone', 'zoning'],
])
const SWIFTLINT = /^\.swiftlint(?:[-_][\w-]+)?\.ya?ml$/
const OXLINT = /^\.?oxlint\.config\.[cm]?ts$/
const NOTICE = /^(?:notices?|third[-_]party[-_]notices?)(?:\.(?:txt|md|markdown|rst|adoc))?$/
const LICENSE = /^(?:(?:licen[cs]e|copying|copyright)(?:[._-]|$)|apache-(?:1\.[01]|2\.0)(?:\.|$))/
const LEGAL_TEXT_EXTENSION = /\.(?:txt|md|markdown|rst|adoc|asciidoc)$/

function fileIconName(name: string) {
  const namedIcon = FILE_NAMES.get(name) ?? ICONS.fileNames[name]
  if (namedIcon) return namedIcon
  if (SWIFTLINT.test(name)) return 'swift'
  if (OXLINT.test(name)) return 'oxc'
  if (NOTICE.test(name)) return 'notice'

  let icon: string | undefined
  for (let dot = name.indexOf('.'); !icon && dot >= 0; dot = name.indexOf('.', dot + 1)) {
    const extension = name.slice(dot + 1)
    icon = FILE_EXTENSIONS.get(extension) ?? ICONS.fileExtensions[extension]
  }
  if ((!icon || LEGAL_TEXT_EXTENSION.test(name)) && LICENSE.test(name)) return 'license'
  return icon ?? ICONS.file
}

/** Resolve project artwork and Material theme associations, including compound suffixes. */
export function projectIcon(node: { name: string; kind: string }, expanded = false) {
  const name = node.name.toLowerCase()
  const icon =
    node.kind === 'directory'
      ? ((expanded ? ICONS.folderNamesExpanded : ICONS.folderNames)[name] ??
        (expanded ? ICONS.folderExpanded : ICONS.folder))
      : fileIconName(name)
  const localIcon = LOCAL_ASSETS[`./file-icons/${icon === 'yaml' ? 'yaml-logo' : icon}.svg`]
  if (localIcon) return localIcon
  const file = (ICONS.iconDefinitions[icon] ?? ICONS.iconDefinitions[ICONS.file])?.iconPath.split('/').pop()
  return file === undefined ? undefined : ASSETS[`../../../../node_modules/material-icon-theme/icons/${file}`]
}
