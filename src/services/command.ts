export type CommandHandler = (command: string, arg: string) => Promise<string>;
