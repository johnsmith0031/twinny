import {
  Configuration,
  CreateCompletionRequestPrompt,
  CreateCompletionResponse,
  OpenAIApi
} from 'openai'
import {
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  Position,
  Range,
  TextDocument,
  workspace,
  StatusBarItem,
  window
} from 'vscode'
import { CompletionRequest, FILL_SPLIT_STR } from './types'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _statusBar: StatusBarItem
  private _lineContexts: string[] = []
  private _lineContextLength = 10
  private _lineContextTimeout = 200
  private _debouncer: NodeJS.Timeout | undefined
  private _config = workspace.getConfiguration('twinny')
  private _debounceWait = this._config.get('debounceWait') as number
  private _contextLength = this._config.get('contextLength') as number
  private _openaiConfig = new Configuration()
  private _serverPath = this._config.get('server')
  private _engine = this._config.get('engine')
  private _usePreviousContext = this._config.get('usePreviousContext')
  private _triggerWhenEditingLine = this._config.get('triggerWhenEditingLine')
  private _removeDoubleNewline = this._config.get('removeDoubleNewline')
  private _basePath = `${this._serverPath}/${this._engine}`
  private _openai: OpenAIApi = new OpenAIApi(this._openaiConfig, this._basePath)
  private _is_debugging: boolean = false

  constructor(statusBar: StatusBarItem) {
    this._statusBar = statusBar
    this.registerOnChangeContextListener()
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    const editor = window.activeTextEditor
    if (!editor) {
      return
    }

    // don't debounce if debounceWait is 0
    if (this._debounceWait === 0) {
      return
    } 

    // If there's a word after the cursor, don't trigger completion.
    if (!this._triggerWhenEditingLine) {
      const line = editor.document.lineAt(position.line)
      const charsAfterRange = new Range(editor.selection.start, line.range.end)
      const textAfterCursor = editor.document.getText(charsAfterRange)
      if (textAfterCursor.trim()) {
        return
      }
    }

    // Make request to get completion items
    return new Promise((resolve) => {
      if (this._debouncer) {
        clearTimeout(this._debouncer)
      }

      this._debouncer = setTimeout(async () => {
        return this.activateCompletionRequest(resolve, document, position)
      }, this._debounceWait as number)
    })
  }
  
  private async activateCompletionRequest(resolve: (value: InlineCompletionItem[]) => void, document: TextDocument, position: Position) {
    if (!this._config.get('enabled'))
      return resolve([] as InlineCompletionItem[])
    
    let prompt = undefined

    // Check if document is jupyter notebook
    if (this._is_debugging) console.debug(document.fileName)
    if (document.fileName.endsWith('.ipynb')) {
      // get active notebook
      const notebook = window.activeNotebookEditor?.notebook

      // get all cells
      const cells = notebook?.getCells()
      if (!cells) return resolve([] as InlineCompletionItem[])

      const current_cell_index = cells.findIndex(cell => cell.document.uri === document.uri)
      
      // get all cell content
      const cell_content = cells?.map(cell => cell.document.getText())

      const cell_spliter = '\n\n'

      // get all cell content before current cell
      let cell_content_before_string = ''
      if (this._is_debugging) console.debug(current_cell_index)
      if (current_cell_index > 0) {
        const cell_content_before = cell_content?.slice(0, current_cell_index)
        cell_content_before_string = cell_content_before?.join(cell_spliter)
      }
      
      let { prefix, suffix } = this.getContext(document, position) // will have bug if rows of current cells are longer than contextLength
      prefix = cell_content_before_string + cell_spliter + prefix

      // get all cell content after current cell
      const cell_length = cells.length
      let cell_content_after_string = ''
      if (current_cell_index < cell_length - 1) {
        const cell_content_after = cell_content?.slice(current_cell_index + 1, cell_length)
        cell_content_after_string = cell_content_after?.join(cell_spliter)
      }
      suffix = suffix + cell_spliter + cell_content_after_string

      prompt = this._getPrompt(prefix, suffix)
      if (this._is_debugging) console.debug(prompt)
    }
    else{
      prompt = this.getPrompt(document, position)
      if (this._is_debugging) console.debug(prompt)
    }

    // get text after cursor
    const textAfterCursor = document.getText(
      new Range(position.line, position.character, position.line, Number.MAX_SAFE_INTEGER)
    )
    let one_line_flag = this._config.get('oneLine')
    if (textAfterCursor && textAfterCursor !== '') {
      one_line_flag = true
    }

    if (!prompt) return resolve([] as InlineCompletionItem[])

    this._statusBar.tooltip = 'twinny - thinking...'
    this._statusBar.text = '$(loading~spin)'

    const options: CompletionRequest = {
      model: '',
      prompt: prompt as CreateCompletionRequestPrompt,
      max_time: this._config.get('maxTime'),
      max_tokens: this._config.get('maxTokens'),
      num_return_sequences: this._config.get('numReturnSequences'),
      temperature: this._config.get('temperature'),
      one_line: one_line_flag as boolean,
      top_p: this._config.get('topP'),
      top_k: this._config.get('topK'),
      repetition_penalty: this._config.get('repetitionPenalty')
    }

    try {
      const { data } = await this._openai.createCompletion(options)
      this._statusBar.text = '$(code)'
      this._statusBar.tooltip = 'twinny - Ready'
      return resolve(this.getInlineCompletions(data, position, document))
    } catch (error) {
      this._statusBar.text = '$(alert)'
      return resolve([] as InlineCompletionItem[])
    }
  }

  private _getPrompt(prefix: string, suffix: string) {
    const prompt = `
      ${this._usePreviousContext ? `${this._lineContexts.join('\n')}\n` : ''}
      ${prefix}${FILL_SPLIT_STR}${suffix}
    `
    return prompt
  }

  private getPrompt(document: TextDocument, position: Position) {
    const { prefix, suffix } = this.getContext(document, position)
    return this._getPrompt(prefix, suffix)
  }

  private registerOnChangeContextListener() {
    let timeout: NodeJS.Timer | undefined
    window.onDidChangeTextEditorSelection((e) => {
      if (!this._usePreviousContext) {
        return
      }
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        const editor = window.activeTextEditor
        if (!editor) return
        const fileUri = editor.document.uri
        const fileName = workspace.asRelativePath(fileUri)
        const document = editor.document
        const line = editor.document.lineAt(e.selections[0].anchor.line)
        const lineText = document.getText(
          new Range(
            line.lineNumber,
            0,
            line.lineNumber,
            line.range.end.character
          )
        )
        if (lineText.trim().length < 2) return // most likely a bracket or un-interesting
        if (this._lineContexts.length === this._lineContextLength) {
          this._lineContexts.pop()
        }
        this._lineContexts.unshift(
          `filename: ${fileName} - code: ${lineText.trim()}`
        )
        this._lineContexts = [...new Set(this._lineContexts)]
      }, this._lineContextTimeout)
    })
  }

  private getContext(
    document: TextDocument,
    position: Position
  ): { prefix: string; suffix: string } {
    const start = Math.max(0, position.line - this._contextLength)
    const prefix = document.getText(
      new Range(start, 0, position.line, position.character)
    )
    const suffix = document.getText(
      new Range(
        position.line,
        position.character,
        position.line + this._contextLength,
        0
      )
    )
    return { prefix, suffix }
  }

  private getInlineCompletions(
    completionResponse: CreateCompletionResponse,
    position: Position,
    document: TextDocument
  ): InlineCompletionItem[] {
    const editor = window.activeTextEditor
    if (!editor) return []
    return (
      completionResponse.choices?.map((choice) => {
        if (position.character !== 0) {
          const charBeforeRange = new Range(
            position.translate(0, -1),
            editor.selection.start
          )
          const charBefore = document.getText(charBeforeRange)
          if (choice.text === ' ' && charBefore === ' ') {
            choice.text = choice.text.slice(1, choice.text.length)
          }
        }
        
        // get text after cursor
        const textAfterCursor = document.getText(
          new Range(position.line, position.character, position.line, Number.MAX_SAFE_INTEGER)
        )
        
        if (textAfterCursor && textAfterCursor !== '') {
          // remove all text from choice.text that appears after textAfterCursor
          choice.text = choice.text?.split(textAfterCursor)[0]
        }

        // if multiple line mode, stop at the value of next line
        if (!this._config.get('oneLine')) {
          const next_row_in_editor = document.getText(
            new Range(position.line + 1, 0, position.line + 1, Number.MAX_SAFE_INTEGER)
          )
          const next_row_in_editor_trim = next_row_in_editor?.trim()
          if (next_row_in_editor_trim !== '') {
            let line_spliter = '\n'
            if (choice.text?.includes('\r\n')) line_spliter = '\r\n'
            const std_text = choice.text?.replace('\r\n', '\n')
            const choice_rows = std_text?.split('\n')
            if (choice_rows) {
              const match_index = choice_rows?.findIndex(row => row.trim() === next_row_in_editor_trim)
              if (match_index !== -1) {
                // join lines before match index
                choice.text = choice_rows.slice(0, match_index).join(line_spliter)
              }
            }
          }
        }
        
        if (this._removeDoubleNewline) {
          // remove all text after double newline
          const doubleNewlineIndex = choice.text?.search(/(\r*\n[ \t]*){2}/)
          if (doubleNewlineIndex !== -1) {
            choice.text = choice.text?.slice(0, doubleNewlineIndex)
          }
        }

        return new InlineCompletionItem(
          choice.text as string,
          new Range(position, position)
        )
      }) || []
    )
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._contextLength = this._config.get('contextLength') as number
    this._serverPath = this._config.get('server')
    this._engine = this._config.get('engine')
    this._usePreviousContext = this._config.get('_usePreviousContext')
    this._triggerWhenEditingLine = this._config.get('triggerWhenEditingLine')
    this._removeDoubleNewline = this._config.get('removeDoubleNewline')

    this._basePath = `${this._serverPath}/${this._engine}`
    this._openai = new OpenAIApi(this._openaiConfig, this._basePath)
  }
}
