import eslint from "@eslint/js";
import typescriptEslint from "typescript-eslint";

const forbiddenCoreModules = [
  "fs",
  "child_process",
  "net",
  "http",
  "https",
  "dns",
  "tls",
  "node-fetch",
  "axios",
  "undici",
];

const forbiddenModule = (moduleName) => {
  const normalizedName = moduleName.startsWith("node:") ? moduleName.slice("node:".length) : moduleName;
  return forbiddenCoreModules.some(
    (name) => normalizedName === name || normalizedName.startsWith(`${name}/`),
  );
};

const reportForbiddenModule = (context, node, source) => {
  if (typeof source === "string" && forbiddenModule(source)) {
    context.report({
      node,
      message: `src/core must not import or load forbidden module "${source}"`,
    });
  }
};

export const corePurityRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow I/O and network dependencies in src/core",
    },
    schema: [],
  },
  create(context) {
    const sourceValue = (node) =>
      node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

    return {
      ImportDeclaration(node) {
        reportForbiddenModule(context, node.source, sourceValue(node.source));
      },
      ExportAllDeclaration(node) {
        reportForbiddenModule(context, node.source, sourceValue(node.source));
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          reportForbiddenModule(context, node.source, sourceValue(node.source));
        }
      },
      ImportExpression(node) {
        reportForbiddenModule(context, node.source, sourceValue(node.source));
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1
        ) {
          reportForbiddenModule(context, node.arguments[0], sourceValue(node.arguments[0]));
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "process" &&
          ((node.computed && node.property.type === "Literal" && node.property.value === "env") ||
            (!node.computed && node.property.type === "Identifier" && node.property.name === "env"))
        ) {
          context.report({
            node,
            message: "src/core must not read process.env",
          });
        }
      },
    };
  },
};

export default [
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  {
    files: ["src/core/**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: {
      dcompact: {
        rules: {
          "core-purity": corePurityRule,
        },
      },
    },
    rules: {
      "dcompact/core-purity": "error",
    },
  },
];
