// MONOLITHIC: The turn owns its streamed tool activity, read editions, proposal identity and apply decision. Extract tool dispatch once it can carry the same per-turn read evidence independently.
import { randomUUID } from 'node:crypto'
import {
  MAX_IDEA_BODY_LENGTH,
  MAX_IDEA_CHAT_CONTEXT_LENGTH,
  MAX_IDEA_TITLE_LENGTH,
} from '../../../shared/ideas/ideas.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import { requestClaude } from './claude-api.mjs'
import {
  ClaudeFileEdits,
  isRecord,
  MAX_CREATION_CHARS,
  MAX_FILE_REPLACEMENTS,
  MAX_REPLACEMENT_CHARS,
  readSource,
  recordExcerpt,
  replacement,
} from './claude-edits.mjs'
import { creaturePrompt } from './claude-prompt.mjs'
import {
  claudeVisiblePath,
  clip,
  lineRange,
  MAX_CLAUDE_EDIT_FILES,
  MAX_CLAUDE_READ_FILES,
  rangeFromLines,
  readClaudeFiles,
} from './claude-workspace.mjs'
import { MAX_GIST_QUERY_LENGTH } from './gist-search.mjs'

const MAX_TOOL_RESULT_CHARS = 28_000
const MAX_HISTORY_CHARS = 12_000
const MAX_HISTORY_MESSAGE_CHARS = 6000
const MAX_MODEL_TRANSCRIPT_CHARS = 64_000
const MAX_DRAFT_CHARS = 12_000
const PROPOSAL_READY = 'The proposal is ready for the user to review.'
const INSPECTION_BUDGET_USED = 'The workspace inspection budget is used up for this message.'
const BATCH_ENTRY_TOO_LARGE = { error: 'Inspection budget exceeded.' }
const ACTION_TOOLS = new Set(['switch_to_edit_mode', 'edit_files', 'propose_idea'])
const IDEA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const pathInput = { type: 'string', description: 'Exact repository-relative path.' }
const rangeInput = {
  start_line: { type: 'integer', minimum: 1 },
  end_line: { type: 'integer', minimum: 1 },
}
const fileReadProperties = { path: pathInput, side: { type: 'string', enum: ['working', 'head'] }, ...rangeInput }
const tools = [
  {
    name: 'list_files',
    description: 'Find project files using a case-insensitive path substring.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read a bounded line range of a project text file. Omit path to use the active file, selection, and side. Lines start at 1.',
    input_schema: {
      type: 'object',
      properties: fileReadProperties,
      additionalProperties: false,
    },
  },
  {
    name: 'read_files',
    description:
      'Read bounded excerpts from several explicit project text files in one call. Each entry can specify a 1-based line range and a side. The side defaults to working. Returns one result or error per entry in request order.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CLAUDE_READ_FILES,
          items: {
            type: 'object',
            properties: fileReadProperties,
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description:
      'Find a literal phrase or symbol in working project files. Returns repository-relative paths, 1-based lines and columns, and short matching excerpts. Case-sensitive by default.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_GIST_QUERY_LENGTH },
        match_case: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_ideas',
    description: 'Find ideas in this Idea Workspace by title or Markdown substring. Returns IDs and titles.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_idea',
    description:
      'Read a bounded range of idea Markdown and linked file locations. Omit id to read the attached idea. Request captured code only if the linked snapshot matters.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ...rangeInput,
        link_offset: { type: 'integer', minimum: 0 },
        include_excerpts: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
]
const editTools = [
  {
    name: 'edit_files',
    description:
      'Stage related edits for review. Pass edits for a file you read, or content for a new file in an existing folder. Later reads show staged working text.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CLAUDE_EDIT_FILES,
          items: {
            type: 'object',
            properties: {
              path: pathInput,
              content: { type: 'string', maxLength: MAX_CREATION_CHARS, description: 'Full text for creation.' },
              edits: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_FILE_REPLACEMENTS,
                items: {
                  type: 'object',
                  properties: {
                    before: {
                      type: 'string',
                      maxLength: MAX_REPLACEMENT_CHARS,
                      description: 'Exact unique text from the working read. Empty for an empty file.',
                    },
                    after: { type: 'string', maxLength: MAX_REPLACEMENT_CHARS },
                    start_line: {
                      type: 'integer',
                      minimum: 1,
                      description: 'Optional line where the snippet begins, to disambiguate repeats.',
                    },
                  },
                  required: ['before', 'after'],
                  additionalProperties: false,
                },
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_idea',
    description:
      'Draft a new idea or update a previously read idea. Supply id for updates. Supply body for full Markdown or before and after to replace one unique excerpt. Omitted fields stay as they are on updates.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string', maxLength: MAX_IDEA_TITLE_LENGTH },
        body: { type: 'string', maxLength: MAX_DRAFT_CHARS },
        before: { type: 'string', description: 'A unique Markdown excerpt for a targeted update.' },
        after: { type: 'string', description: 'Replacement Markdown for the excerpt. It may be empty.' },
      },
      additionalProperties: false,
    },
  },
]

const askTools = [
  ...tools,
  {
    name: 'switch_to_edit_mode',
    description: 'Continue this request in Edit mode when the user asks you to change project files or an idea.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
]
const editingTools = [...tools, ...editTools]

/** @type {Record<string, readonly [string, string, string]>} */
const TOOL_LABELS = {
  list_files: ['Finding files', 'Looked up files', 'Couldn’t look up files'],
  read_file: ['Reading file', 'Read file', 'Couldn’t read file'],
  read_files: ['Reading files', 'Read files', 'Couldn’t read files'],
  search_files: ['Searching project text', 'Searched project text', 'Couldn’t search project text'],
  list_ideas: ['Finding ideas', 'Looked up ideas', 'Couldn’t look up ideas'],
  read_idea: ['Reading idea', 'Read idea', 'Couldn’t read idea'],
  switch_to_edit_mode: ['Switching to Edit mode', 'Switched to Edit mode', 'Couldn’t switch to Edit mode'],
  edit_files: ['Staging file changes', 'Staged file changes', 'Couldn’t stage file changes'],
  propose_idea: ['Preparing idea draft', 'Prepared idea draft', 'Couldn’t prepare idea draft'],
}

/** @typedef {import('../../../shared/ideas/ideas.ts').Idea} Idea */
/** @typedef {'working' | 'head'} SourceSide */
/** @typedef {{ path: string, side: SourceSide, startLine?: number, endLine?: number }} FileReference */
/** @typedef {{ path: string, side: SourceSide, startLine: unknown, endLine: unknown }} FileRead */
/** @typedef {import('./claude-edits.mjs').ReadSource} ReadSource */
/** @typedef {import('./claude-edits.mjs').FileChange} FileChange */
/** @typedef {import('./claude-edits.mjs').FilesProposal} FilesProposal */
/** @typedef {{ prompt: string, path?: string, proposeEdits: boolean, ideaContext?: string, ideaId?: string, requestId?: string, fileContext?: FileReference }} ClaudePrompt */
/** @typedef {{ id: string, kind: 'idea', action: 'create' | 'update', ideaId: string, title: string, beforeTitle?: string, before: string, after: string }} IdeaProposalPreview */
/** @typedef {{ kind: 'idea', preview: IdeaProposalPreview, source: Idea | undefined, idea: Idea }} IdeaProposal */
/** @typedef {FilesProposal | IdeaProposal} Proposal */
/** @typedef {{ type: 'tool', id: string, name: string, step: number, detail?: string, path?: string, side?: SourceSide, startLine?: number, endLine?: number }} ToolActivity */
/** @typedef {{ type: 'text', text: string, step: number } | { type: 'mode', mode: 'edit', step: number } | (ToolActivity & { label: string, status: 'running' | 'done' | 'error' })} Activity */
/** @typedef {Activity & { requestId: string }} ClaudeActivity */
/** @typedef {{ role: 'user' | 'assistant', content: string }} HistoryMessage */
/** @typedef {ReturnType<typeof import('../../../shared/diagnostics/diagnostics.ts').createDiagnostics>} Diagnostics */
/**
 * @typedef {object} ClaudeWorkspace
 * @property {(query: string) => Promise<unknown>} list
 * @property {(path: string, side: SourceSide) => Promise<string>} read
 * @property {(query: string, matchCase: boolean, signal: AbortSignal) => Promise<Awaited<ReturnType<typeof import('./gist-search.mjs').searchClaudeGist>>>} search
 * @property {(path: string) => Promise<void>} checkCreate
 * @property {(query: string) => Promise<unknown>} listIdeas
 * @property {(id: string) => Promise<Idea | undefined>} readIdea
 */
/**
 * @typedef {object} ProposalWorkspace
 * @property {(files: FileChange[]) => Promise<void>} saveFiles
 * @property {(idea: Idea, source: Idea | undefined) => Promise<Idea>} saveIdea
 */

/** @param {string} text */
function display(text) {
  // oxlint-disable-next-line no-control-regex -- Activity labels cannot contain control characters.
  return clip(text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' '), 400)
}

/** @param {Idea} idea @param {Record<string, unknown>} args */
function ideaLinks(idea, args) {
  const offset = args.link_offset ?? 0
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Choose a valid offset for linked files.')
  const visible = idea.links.filter(link => claudeVisiblePath(link.path))
  const links = []
  let pathBudget = 4500
  let excerptBudget = args.include_excerpts === true ? 3000 : 0
  for (const { path, line, endLine, side, excerpt, truncated } of visible.slice(offset, offset + 12)) {
    if (path.length > pathBudget) break
    const snapshot = excerpt && excerptBudget > 0 ? clip(excerpt, excerptBudget) : undefined
    links.push({
      path,
      line,
      endLine,
      side,
      excerpt: snapshot,
      excerptTruncated: snapshot ? Boolean(truncated) || snapshot.length < (excerpt?.length ?? 0) : undefined,
    })
    pathBudget -= path.length
    excerptBudget -= snapshot?.length ?? 0
  }
  const next = offset + links.length
  return { links, nextLinkOffset: next < visible.length ? next : undefined }
}

/** @param {Record<string, unknown>} input @returns {FileReference | undefined} */
function fileReference(input) {
  const context = isRecord(input.fileContext) ? input.fileContext : undefined
  const path = context?.path ?? input.path
  if (!claudeVisiblePath(path)) return undefined
  const startLine =
    typeof context?.startLine === 'number' && Number.isSafeInteger(context.startLine) && context.startLine >= 1
      ? context.startLine
      : undefined
  const endLine =
    startLine &&
    typeof context?.endLine === 'number' &&
    Number.isSafeInteger(context.endLine) &&
    context.endLine >= startLine
      ? context.endLine
      : startLine
  return { path, side: context?.side === 'head' ? 'head' : 'working', startLine, endLine }
}

/**
 * @param {Record<string, unknown>} args
 * @param {FileReference | undefined} active
 * @returns {FileRead}
 */
function readReference(args, active) {
  const usesActive = args.path === undefined
  const path = usesActive ? active?.path : args.path
  if (!claudeVisiblePath(path)) throw new Error('Supply the path of a project text file.')
  const side = args.side ?? (usesActive ? active?.side : 'working')
  if (side !== 'working' && side !== 'head') throw new Error('Choose the working file or HEAD.')
  const useSelection = usesActive && args.start_line === undefined && args.end_line === undefined
  const startLine = useSelection ? active?.startLine : args.start_line
  const endLine = useSelection ? active?.endLine : args.end_line
  return { path, side, startLine, endLine }
}

/** @param {Record<string, unknown>} args @param {Idea | undefined} source @returns {IdeaProposal} */
function ideaDraft(args, source) {
  const action = source ? 'update' : 'create'
  const id = source?.id ?? randomUUID()
  const title = args.title === undefined ? (source?.title ?? '') : args.title
  if (
    typeof title !== 'string' ||
    title.length > MAX_IDEA_TITLE_LENGTH ||
    !title.isWellFormed() ||
    (args.title !== undefined && !title.trim()) ||
    (!source && !title.trim())
  )
    throw new Error('Provide a valid idea title of up to 200 characters.')
  const previous = source?.body ?? ''
  const bodyInput = args.body === undefined ? previous : args.body
  let body
  let before = previous
  let after
  if (args.before !== undefined || args.after !== undefined) {
    if (!source || args.body !== undefined)
      throw new Error('Use an existing idea and a Markdown excerpt for a targeted update.')
    const edit = replacement(previous, args.before, args.after)
    body = edit.text
    before = edit.before
    after = edit.after
  } else if (args.body === undefined && source) {
    body = previous
    before = after = ''
  } else if (
    typeof bodyInput !== 'string' ||
    bodyInput.length > MAX_DRAFT_CHARS ||
    !bodyInput.isWellFormed() ||
    bodyInput.includes('\0')
  ) {
    throw new Error('Idea drafts can include up to 12,000 characters of Markdown.')
  } else if (previous.length > MAX_DRAFT_CHARS) {
    throw new Error('Replace a specific Markdown excerpt in this long idea.')
  } else {
    body = after = bodyInput
  }
  if (body.length > MAX_IDEA_BODY_LENGTH) throw new Error('The idea would exceed the note length limit.')
  if (source?.title === title && source.body === body) throw new Error('Propose a change to the title or Markdown.')
  const now = Math.max(Date.now(), source ? source.updatedAt + 1 : 0)
  const idea = { id, title, body, links: source?.links ?? [], createdAt: source?.createdAt ?? now, updatedAt: now }
  return {
    kind: 'idea',
    preview: { id: randomUUID(), kind: 'idea', action, ideaId: id, title, beforeTitle: source?.title, before, after },
    idea,
    source,
  }
}

export class ClaudeSession {
  /** @type {HistoryMessage[]} */
  #history = []
  /** @type {AbortController | undefined} */
  #controller
  /** @type {Proposal | undefined} */
  #proposal
  #applying = false
  /** @type {Diagnostics | undefined} */
  #diagnostics

  /** @param {Diagnostics} [diagnostics] */
  constructor(diagnostics) {
    this.#diagnostics = diagnostics
  }

  cancel() {
    this.#controller?.abort()
  }

  reset() {
    this.cancel()
    this.#controller = undefined
    this.#history = []
    this.#proposal = undefined
  }

  /**
   * @param {unknown} input
   * @param {() => Promise<string>} getKey
   * @param {ClaudeWorkspace} workspace
   * @param {(activity: ClaudeActivity) => void} [onActivity]
   */
  async send(input, getKey, workspace, onActivity) {
    if (this.#controller || this.#applying) throw new Error('The Creature is still working.')
    if (this.#proposal) throw new Error('Apply or discard the proposal first.')
    const prompt = isRecord(input) && typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt || prompt.length > 8000) throw new Error('Enter a message of up to 8,000 characters.')
    if (!isRecord(input)) throw new Error('Invalid message.')
    const { ideaContext, ideaId, requestId } = input
    if (
      ideaContext !== undefined &&
      (typeof ideaContext !== 'string' || ideaContext.length > MAX_IDEA_CHAT_CONTEXT_LENGTH)
    )
      throw new Error('The attached idea exceeds the chat context limit.')
    if (ideaId !== undefined && (typeof ideaId !== 'string' || !IDEA_ID_PATTERN.test(ideaId)))
      throw new Error('The attached idea is invalid.')

    const controller = new AbortController()
    const timeout = AbortSignal.timeout(120_000)
    const signal = AbortSignal.any([controller.signal, timeout])
    this.#controller = controller
    const active = fileReference(input)
    let canEdit = input.proposeEdits === true
    const references = [
      active ? `Active editor reference: ${JSON.stringify(active)}` : '',
      ideaId ? `Attached Idea Workspace note ID: ${JSON.stringify(ideaId)}` : '',
    ].filter(Boolean)
    const userText = [...references, prompt].join('\n\n')
    /** @type {import('./claude-api.mjs').ClaudeMessage['content']} */
    const userContent =
      !ideaId && ideaContext?.trim()
        ? [
            { type: 'text', text: userText },
            { type: 'text', text: `Attached Idea Workspace note:\n\n${ideaContext}` },
          ]
        : userText
    /** @type {import('./claude-api.mjs').ClaudeMessage[]} */
    const messages = [...this.#history, { role: 'user', content: userContent }]
    /** @type {Map<string, ReadSource>} */
    const readFiles = new Map()
    /** @type {Map<string, { idea: Idea, excerpts: string[], complete: boolean }>} */
    const readIdeas = new Map()
    const fileEdits = new ClaudeFileEdits()
    /** @type {Proposal | undefined} */
    let proposal
    let toolCalls = 0
    let toolResultChars = 0
    /** @param {Activity} activity */
    const emit = activity => {
      if (!signal.aborted && typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128)
        onActivity?.({ requestId, ...activity })
    }

    /** @param {string} key @param {string} path @param {SourceSide} side */
    const loadSource = async (key, path, side) => {
      const staged = side === 'working' ? fileEdits.text(path) : undefined
      return readFiles.get(key) ?? readSource(staged ?? (await workspace.read(path, side)))
    }

    /** @param {Map<string, Promise<ReadSource>>} sources @param {FileRead} reference */
    const batchSource = (sources, { path, side }) => {
      const key = `${side}:${path}`
      let pending = sources.get(key)
      if (!pending) {
        pending = loadSource(key, path, side)
        sources.set(key, pending)
      }
      return pending
    }

    /** @param {ReadSource} source @param {{path: string, side: SourceSide, startLine: number, endLine: number, text: string}} output */
    const recordRead = (source, output) => {
      recordExcerpt(source, output)
      readFiles.set(`${output.side}:${output.path}`, source)
    }

    /** @param {unknown} files @param {ToolActivity} activity */
    const readBatch = async (files, activity) => {
      const count = Array.isArray(files) ? files.length : 0
      const entryBudget = Math.floor((MAX_TOOL_RESULT_CHARS - toolResultChars - 64) / Math.max(count, 1))
      if (count > 0 && count <= MAX_CLAUDE_READ_FILES && entryBudget < JSON.stringify(BATCH_ENTRY_TOO_LARGE).length)
        throw new Error(INSPECTION_BUDGET_USED)
      /** @type {Map<string, Promise<ReadSource>>} */
      const sources = new Map()
      const entries = await readClaudeFiles(
        files,
        async args => {
          const reference = readReference(args, undefined)
          const { path, side, startLine, endLine } = reference
          const source = await batchSource(sources, reference)
          const limit = Math.max(1, entryBudget - JSON.stringify(path).length - 128)
          let output = { path, side, ...rangeFromLines(source.lines, startLine, endLine, Math.min(6500, limit)) }
          if (JSON.stringify(output).length > entryBudget) {
            // JSON escapes can use up to six characters per code unit.
            output = {
              path,
              side,
              ...rangeFromLines(source.lines, startLine, endLine, Math.max(1, Math.floor(limit / 6))),
            }
          }
          return { source, output }
        },
        signal,
      )
      /** @type {Extract<(typeof entries)[number], { output: unknown }>[] } */
      const included = []
      let truncated = false
      const results = entries.map(entry => {
        const output = 'output' in entry ? entry.output : entry
        if (JSON.stringify(output).length > entryBudget) {
          truncated = true
          return BATCH_ENTRY_TOO_LARGE
        }
        if ('output' in entry) {
          included.push(entry)
          truncated ||= entry.output.truncated
        }
        return output
      })
      const content = encodeToolResult({ files: results, truncated })
      for (const { source, output } of included) recordRead(source, output)
      activity.detail = `${included.length} of ${count} ${count === 1 ? 'file' : 'files'}`
      return content
    }

    /** @param {string} name @param {Record<string, unknown>} args @param {ToolActivity} activity */
    const execute = async (name, args, activity) => {
      signal.throwIfAborted()
      if (name === 'switch_to_edit_mode') {
        if (Object.keys(args).length) throw new Error('Switch to Edit mode without arguments.')
        if (!canEdit) {
          canEdit = true
          emit({ type: 'mode', mode: 'edit', step: activity.step })
        }
        return 'Edit mode is active. Continue the user’s request with the available editing tools.'
      }
      if (name === 'list_files' || name === 'list_ideas') {
        const query = typeof args.query === 'string' ? args.query.trim().slice(0, 256) : ''
        return name === 'list_files' ? workspace.list(query.toLowerCase()) : workspace.listIdeas(query)
      }
      if (name === 'read_file') {
        const { path, side, startLine, endLine } = readReference(args, active)
        activity.detail = display(path)
        const source = await loadSource(`${side}:${path}`, path, side)
        const room = MAX_TOOL_RESULT_CHARS - toolResultChars - JSON.stringify(path).length - 160
        if (room < 1) throw new Error(INSPECTION_BUDGET_USED)
        let output = { path, side, ...rangeFromLines(source.lines, startLine, endLine, Math.min(6500, room)) }
        if (JSON.stringify(output).length > MAX_TOOL_RESULT_CHARS - toolResultChars)
          output = {
            path,
            side,
            ...rangeFromLines(source.lines, startLine, endLine, Math.max(1, Math.floor(room / 6))),
          }
        const content = encodeToolResult(output)
        recordRead(source, output)
        activity.path = path
        activity.side = side
        activity.startLine = output.startLine
        activity.endLine = output.endLine
        return content
      }
      if (name === 'read_files') return readBatch(args.files, activity)
      if (name === 'search_files') {
        const { query, match_case: matchCase = true } = args
        if (typeof query !== 'string' || typeof matchCase !== 'boolean')
          throw new Error('Supply a literal phrase and an optional case-sensitivity setting.')
        const result = await workspace.search(query, matchCase, signal)
        const count = result.matches.length
        activity.detail = `${count} ${count === 1 ? 'match' : 'matches'}`
        return result
      }
      if (name === 'read_idea') {
        const id = args.id ?? ideaId
        if (typeof id !== 'string' || !IDEA_ID_PATTERN.test(id)) throw new Error('Supply an idea ID.')
        const previous = readIdeas.get(id)
        const idea = previous?.idea ?? (await workspace.readIdea(id))
        if (!idea) throw new Error('That idea is no longer available in this workspace.')
        const markdown = lineRange(idea.body, args.start_line, args.end_line)
        const links = ideaLinks(idea, args)
        const content = encodeToolResult({ id, title: idea.title, markdown, ...links })
        const complete = !markdown.truncated && markdown.startLine === 1 && markdown.endLine === markdown.totalLines
        readIdeas.set(id, {
          idea,
          excerpts: [...(previous?.excerpts ?? []), markdown.text],
          complete: previous?.complete === true || complete,
        })
        activity.detail = display(idea.title || 'Untitled idea')
        return content
      }
      if (name === 'edit_files' && canEdit) {
        if (proposal) throw new Error('A separate proposal is already ready this turn.')
        const count = await fileEdits.stage(args.files, readFiles, workspace.checkCreate, signal)
        activity.detail = `${count} ${count === 1 ? 'file' : 'files'} in review`
        return { stagedFiles: count }
      }
      if (name === 'propose_idea' && canEdit) {
        if (proposal || fileEdits.size) throw new Error('A separate proposal is already ready this turn.')
        const read = typeof args.id === 'string' ? readIdeas.get(args.id) : undefined
        if (args.id !== undefined && !read) throw new Error('Read the idea before proposing an update.')
        if (read && args.body !== undefined && !read.complete)
          throw new Error('Use a targeted excerpt replacement when you have only part of the idea.')
        if (read && typeof args.before === 'string') {
          const excerpt = args.before.replace(/\r\n?|\n/gu, '\n')
          if (!read.excerpts.some(text => text.includes(excerpt)))
            throw new Error('Read the Markdown you want to replace before proposing an update.')
        }
        proposal = ideaDraft(args, read?.idea)
        activity.detail = display(proposal.preview.title)
        return PROPOSAL_READY
      }
      throw new Error('This tool is unavailable.')
    }

    /** @param {unknown} output @param {boolean} [inspection] */
    function encodeToolResult(output, inspection = true) {
      const content = typeof output === 'string' ? output : JSON.stringify(output)
      if (content === undefined) throw new Error('The workspace tool returned no result.')
      if (inspection && toolResultChars + content.length > MAX_TOOL_RESULT_CHARS)
        throw new Error(INSPECTION_BUDGET_USED)
      return content
    }

    /** @param {string} text @param {number} step @param {Proposal} [proposed] */
    const finish = (text, step, proposed) => {
      signal.throwIfAborted()
      /** @type {HistoryMessage[]} */
      const history = [
        ...this.#history,
        { role: 'user', content: clip(userText, MAX_HISTORY_MESSAGE_CHARS) },
        { role: 'assistant', content: clip(text, MAX_HISTORY_MESSAGE_CHARS) },
      ]
      let start = history.length - 2
      let characters = (history[start]?.content.length ?? 0) + (history[start + 1]?.content.length ?? 0)
      while (start >= 2 && history.length - start < 10) {
        const previousTurn = (history[start - 2]?.content.length ?? 0) + (history[start - 1]?.content.length ?? 0)
        if (characters + previousTurn > MAX_HISTORY_CHARS) break
        characters += previousTurn
        start -= 2
      }
      this.#history = history.slice(start)
      this.#proposal = proposed
      return { text, step, proposal: proposed?.preview }
    }

    const maxSteps = 10
    const diagnostics = this.#diagnostics
    const startedAt = performance.now()
    let receivedText = false
    let transcriptSize = 0
    try {
      const key = await getKey()
      for (let step = 0; step < maxSteps; step++) {
        signal.throwIfAborted()
        let streamed = false
        /** @param {string} text */
        const onText = text => {
          streamed = true
          if (!receivedText) {
            receivedText = true
            diagnostics?.measure('assistant.first-response', startedAt)
          }
          emit({ type: 'text', text, step })
        }
        const availableTools = canEdit ? editingTools : askTools
        const system = creaturePrompt(canEdit)
        const request = () =>
          requestClaude(key, { system, messages, tools: availableTools, edit: canEdit }, signal, onText)
        // oxlint-disable-next-line no-await-in-loop -- Each model round requires the previous tool results.
        const reply = await (diagnostics?.run('assistant.model.request', request) ?? request())
        signal.throwIfAborted()
        const text = reply.text
          .map(block => block.text)
          .join('\n\n')
          .trim()
        if (text && !streamed) onText(text)
        if (reply.stopReason === 'max_tokens') {
          const draft = proposal ?? fileEdits.proposal()
          const limit = draft
            ? 'Creature ran out of room. The changes prepared so far are ready to review.'
            : 'Creature ran out of room. Try asking for a smaller change or a shorter answer.'
          return finish([text, limit].filter(Boolean).join('\n\n'), step, draft)
        }
        if (reply.stopReason !== 'tool_use') {
          const proposed = reply.stopReason === 'end_turn' ? (proposal ?? fileEdits.proposal()) : undefined
          const fallback = proposed ? 'Creature has a change for you to look at.' : 'Creature has no answer this time.'
          return finish(text || fallback, step, proposed)
        }
        const { calls } = reply
        toolCalls += calls.length
        transcriptSize += JSON.stringify(reply.content).length
        if (!calls.length || toolCalls > 24 || step === maxSteps - 1 || transcriptSize > MAX_MODEL_TRANSCRIPT_CHARS)
          break
        /** @type {import('./claude-api.mjs').ClaudeToolResult[]} */
        const results = []
        for (const block of calls) {
          const args = block.input
          const knownTool = Object.hasOwn(TOOL_LABELS, block.name) ? TOOL_LABELS[block.name] : undefined
          const [running, done, failed] = knownTool ?? ['Using tool', 'Used tool', 'Tool unavailable']
          const operation = knownTool ? `assistant.tool.${block.name.replaceAll('_', '-')}` : 'assistant.tool.unknown'
          const toolStartedAt = performance.now()
          /** @type {ToolActivity} */
          const activity = { type: 'tool', id: block.id, name: block.name, step }
          if (block.name === 'read_file') {
            const path = args.path ?? active?.path
            if (claudeVisiblePath(path)) activity.detail = display(path)
          }
          emit({ ...activity, label: running, status: 'running' })
          try {
            if (!availableTools.some(tool => tool.name === block.name)) throw new Error('This tool is unavailable.')
            const inspection = !ACTION_TOOLS.has(block.name)
            if (inspection && toolResultChars + 256 > MAX_TOOL_RESULT_CHARS) throw new Error(INSPECTION_BUDGET_USED)
            // oxlint-disable-next-line no-await-in-loop -- Calls share a budget and may depend on earlier reads in the round.
            const output = await execute(block.name, args, activity)
            signal.throwIfAborted()
            const content = encodeToolResult(output, inspection)
            if (inspection) toolResultChars += content.length
            results.push({ type: 'tool_result', tool_use_id: block.id, content })
            emit({ ...activity, label: done, status: 'done' })
            diagnostics?.measure(operation, toolStartedAt)
          } catch (error) {
            if (!signal.aborted) diagnostics?.measure(operation, toolStartedAt, { ok: false, error })
            const content = error instanceof Error ? clip(error.message, 400) : 'This tool could not finish.'
            results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: true })
            emit({ ...activity, label: failed, status: 'error' })
            signal.throwIfAborted()
          }
        }
        transcriptSize += JSON.stringify(results).length
        if (transcriptSize > MAX_MODEL_TRANSCRIPT_CHARS) break
        messages.push({ role: 'assistant', content: reply.content }, { role: 'user', content: results })
      }
      diagnostics?.event('assistant.tool.budget', 'warn')
      proposal ??= fileEdits.proposal()
      return finish(
        proposal
          ? 'Creature reached the tool limit. The changes prepared so far are ready to review.'
          : 'Creature looked through as much as it could. Try a smaller question or name a file or idea.',
        maxSteps,
        proposal,
      )
    } catch (error) {
      if (controller.signal.aborted)
        throw appError(new Error('Request canceled.', { cause: error }), { code: 'ABORT_ERR' })
      if (timeout.aborted)
        throw appError(new Error('The Creature took too long to respond. Try again.', { cause: error }), {
          code: 'ETIMEDOUT',
        })
      throw error
    } finally {
      if (this.#controller === controller) this.#controller = undefined
    }
  }

  /** @param {unknown} id */
  #approved(id) {
    if (!this.#proposal || this.#proposal.preview.id !== id || this.#applying)
      throw new Error('This proposal is no longer available.')
    return this.#proposal
  }

  /** @param {'discarded' | 'applied'} decision @param {Proposal} proposal */
  #recordDecision(decision, proposal) {
    const last = this.#history.at(-1)
    if (!last) return
    const preview = proposal.preview
    const subject = preview.kind === 'idea' ? preview.title : preview.files.map(file => file.path).join(', ')
    last.content += `\n\nThe user ${decision} the proposal for ${JSON.stringify(clip(subject, 1200))}.`
  }

  /** @param {unknown} id */
  discard(id) {
    const proposal = this.#approved(id)
    this.#proposal = undefined
    this.#recordDecision('discarded', proposal)
  }

  /** @param {unknown} id @param {ProposalWorkspace} workspace */
  async apply(id, workspace) {
    const proposal = this.#approved(id)
    this.#applying = true
    try {
      let result
      if (proposal.kind === 'idea') result = { idea: await workspace.saveIdea(proposal.idea, proposal.source) }
      else {
        await workspace.saveFiles(proposal.changes)
        result = { paths: proposal.changes.map(file => file.path) }
      }
      if (this.#proposal === proposal) {
        this.#proposal = undefined
        this.#recordDecision('applied', proposal)
      }
      return result
    } finally {
      this.#applying = false
    }
  }
}
