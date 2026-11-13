export interface GuideCommand {
  id: string;
  title: string;
  category: string;
  keys: string[];
  vimKeys: string[];
  hidden: boolean;
}
export interface GuideRelease {
  version: string;
  date: string;
  sections: { type: string; entries: { title: string; body: string }[] }[];
}
export interface GuideTheme {
  name: string;
  scheme: "dark" | "light";
  family: string;
  tokens: Record<string, string>;
}
export function extractLiteral(src: string, marker: string): string;
export function parseCommands(src: string): GuideCommand[];
export function parseThemes(themesSrc: string, toolsSrc: string): { themes: GuideTheme[]; families: { id: string; title: string; hint: string }[] };
export function parseModes(src: string): { prefix: string; label: string; hint: string }[];
export function constant(src: string, name: string): number;
export function parseChangelog(md: string): GuideRelease[];
export function readContent(dir?: string): { file: string; html: string; id: string; title: string; group: string }[];
export function buildNav(sections: { id: string; title: string; group: string }[]): string;
export function build(): {
  html: string;
  data: { version: string; commands: GuideCommand[]; themes: GuideTheme[]; families: unknown[]; modes: unknown[]; changelog: GuideRelease[] };
  sections: { file: string; html: string; id: string; title: string; group: string }[];
};
