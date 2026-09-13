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
  "process",
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
    const sourceCode = context.sourceCode;
    const hostBindings = new Map();

    const sourceValue = (node) =>
      node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

    const bindingFor = (node) => {
      if (node?.type !== "Identifier") {
        return undefined;
      }

      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (variable) {
          return variable;
        }
      }
      return undefined;
    };

    const globalBinding = (node, name) => {
      if (node?.type !== "Identifier" || node.name !== name) {
        return false;
      }
      const variable = bindingFor(node);
      return !variable || variable.defs.length === 0;
    };

    const staticPropertyName = (node) => {
      if (!node) {
        return undefined;
      }
      if (!node.computed && node.type === "Identifier") {
        return node.name;
      }
      return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
    };

    const unwrap = (node) => {
      let current = node;
      while (
        current?.type === "ChainExpression" ||
        current?.type === "TSAsExpression" ||
        current?.type === "TSNonNullExpression" ||
        current?.type === "TSInstantiationExpression"
      ) {
        current = current.expression;
      }
      return current;
    };

    // Track aliases so `const host = globalThis; host.process` is covered too.
    const hostKind = (expression) => {
      const node = unwrap(expression);
      if (!node) {
        return undefined;
      }
      if (node.type === "Identifier") {
        if (node.name === "process" && globalBinding(node, "process")) {
          return "process";
        }
        if (node.name === "globalThis" && globalBinding(node, "globalThis")) {
          return "globalThis";
        }
        return hostBindings.get(bindingFor(node));
      }
      if (node.type === "MemberExpression") {
        if (hostKind(node.object) === "globalThis" && staticPropertyName(node.property) === "process") {
          return "process";
        }
      }
      return undefined;
    };

    const markBinding = (node, kind) => {
      const identifier = unwrap(node);
      if (identifier?.type === "Identifier") {
        const variable = bindingFor(identifier);
        if (variable) {
          hostBindings.set(variable, kind);
        }
      }
    };

    const patternContainsProcessProperty = (pattern) => {
      const node = unwrap(pattern);
      if (!node) {
        return false;
      }
      if (node.type === "ObjectPattern") {
        return node.properties.some(
          (property) =>
            property.type === "Property" &&
            staticPropertyName(property.key) === "process",
        );
      }
      if (node.type === "AssignmentPattern" || node.type === "RestElement") {
        return patternContainsProcessProperty(node.left || node.argument);
      }
      return false;
    };

    const markPattern = (pattern, kind) => {
      const node = unwrap(pattern);
      if (!node) {
        return;
      }
      if (node.type === "Identifier") {
        markBinding(node, kind);
        return;
      }
      if (node.type === "AssignmentPattern") {
        markPattern(node.left, kind);
        return;
      }
      if (node.type !== "ObjectPattern") {
        return;
      }
      for (const property of node.properties) {
        if (property.type !== "Property") {
          continue;
        }
        const propertyName = staticPropertyName(property.key);
        if (kind === "globalThis" && propertyName === "process") {
          markPattern(property.value, "process");
        }
      }
    };

    const reportHostProcess = (node) => {
      context.report({
        node,
        message: "src/core must not access the host process object",
      });
    };

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
      VariableDeclarator(node) {
        const kind = hostKind(node.init);
        if (kind) {
          if (kind === "globalThis" && patternContainsProcessProperty(node.id)) {
            reportHostProcess(node);
          }
          markPattern(node.id, kind);
        }
      },
      AssignmentExpression(node) {
        const kind = hostKind(node.right);
        if (kind) {
          if (kind === "globalThis" && patternContainsProcessProperty(node.left)) {
            reportHostProcess(node);
          }
          markPattern(node.left, kind);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          globalBinding(node.callee, "require")
        ) {
          reportForbiddenModule(context, node.arguments[0], sourceValue(node.arguments[0]));
        }
      },
      Identifier(node) {
        if (node.name !== "process") {
          return;
        }

        // A property key named `process` is not an access to the host object:
        // `thing.process` and `{ process: value }` are both allowed unless
        // their object is separately recognized below.
        if (
          (node.parent.type === "MemberExpression" &&
            node.parent.property === node &&
            !node.parent.computed) ||
          (node.parent.type === "Property" &&
            node.parent.key === node &&
            !node.parent.computed &&
            (!node.parent.shorthand || node.parent.parent?.type === "ObjectPattern")) ||
          ((node.parent.type === "MethodDefinition" || node.parent.type === "PropertyDefinition") &&
            node.parent.key === node &&
            !node.parent.computed)
        ) {
          return;
        }

        if (hostKind(node) === "process") {
          reportHostProcess(node);
        }
      },
      MemberExpression(node) {
        const object = unwrap(node.object);
        const processMember =
          hostKind(node.object) === "globalThis" && staticPropertyName(node.property) === "process";
        const processObjectMember = hostKind(node.object) === "process";

        // The nested member already reports the transition from globalThis to
        // process in `globalThis.process.env`; avoid a duplicate diagnostic on
        // the outer `.env` access.
        if (
          processMember ||
          (processObjectMember && object?.type !== "MemberExpression")
        ) {
          reportHostProcess(node);
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
