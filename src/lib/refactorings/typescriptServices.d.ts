// The TypeScript Monaco bundles (for its TS worker), also used on the main
// thread by the TS/JS refactorings (src/lib/refactorings/typescript.ts).
declare module "monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js" {
  export const typescript: typeof import("typescript");
}
