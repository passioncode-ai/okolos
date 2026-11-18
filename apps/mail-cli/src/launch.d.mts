export declare const FAILED: 2

export declare const NODE_RANGE: string

export declare function runsFromSources(node: string, typescript: string | false | undefined): boolean

export interface Command {
  readonly run: (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<void> | void
}

export declare const LAUNCHED: unique symbol

export declare function installHook(): void

export declare function loadSources(): Promise<Command>

export declare function launch(options: {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly node?: string
  readonly typescript?: string | false | undefined
  readonly load?: () => Promise<Command>
  readonly write?: (text: string) => void
}): Promise<number | undefined>
