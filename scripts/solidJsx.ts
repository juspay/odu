import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

type Transformed = { code?: string | null } | null;

const babel = require_("@babel/core") as {
  transformSync: (code: string, options: Record<string, unknown>) => Transformed;
  transformAsync: (code: string, options: Record<string, unknown>) => Promise<Transformed>;
};

export const SOLID_PRESETS: readonly unknown[] = [
  [require_("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
  [require_("babel-preset-solid"), {}],
];

const OPTIONS = { babelrc: false, configFile: false, presets: SOLID_PRESETS };

const produced = (out: Transformed, filename: string): string => {
  const code = out?.code;
  if (code == null) throw new Error(`the Solid compiler produced nothing for ${filename}`);
  return code;
};

export function compileSolid(source: string, filename: string): string {
  return produced(babel.transformSync(source, { ...OPTIONS, filename }), filename);
}

export async function compileSolidAsync(source: string, filename: string): Promise<string> {
  return produced(
    await babel.transformAsync(source, { ...OPTIONS, filename, sourceMaps: "inline" }),
    filename,
  );
}
