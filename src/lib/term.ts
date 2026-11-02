import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";

export type Color = Parameters<typeof styleText>[0];

/** Colors text for stdout; plain when stdout is not a terminal or NO_COLOR is set. */
export function paint(color: Color | undefined, text: string): string {
  return color ? styleText(color, text, { stream: process.stdout }) : text;
}

/** Writes one line to stdout, optionally colored. */
export function say(text = "", color?: Color): void {
  process.stdout.write(paint(color, text) + "\n");
}

/** Asks a question on the terminal and returns the trimmed answer. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** "1 entry" / "3 entries". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
