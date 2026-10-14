// The `emmet` package ships types, but its package.json "exports" hides
// them from TypeScript's bundler resolution: the parts Sable uses.
declare module "emmet" {
  export type SyntaxType = "markup" | "stylesheet";

  export interface UserConfig {
    type?: SyntaxType;
    syntax?: string;
    text?: string | string[];
    options?: Record<string, unknown>;
  }

  export interface ExtractedAbbreviation {
    abbreviation: string;
    location: number;
    start: number;
    end: number;
  }

  export default function expandAbbreviation(abbreviation: string, config?: UserConfig): string;
  export function extract(
    line: string,
    position?: number,
    options?: { type?: SyntaxType; lookAhead?: boolean; prefix?: string },
  ): ExtractedAbbreviation | undefined;
  export function resolveConfig(config?: UserConfig): { snippets: Record<string, string> };
}
