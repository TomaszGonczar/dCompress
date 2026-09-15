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

const reportDynamicModule = (context, node) => {
  context.report({
    node,
    message: "src/core must use a statically analyzable module specifier",
  });
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

    const constantString = (expression) => {
      const node = unwrap(expression);
      if (node?.type === "Literal" && typeof node.value === "string") {
        return node.value;
      }
      if (node?.type === "TemplateLiteral") {
        let value = node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
        for (let index = 0; index < node.expressions.length; index += 1) {
          const expressionValue = constantString(node.expressions[index]);
          const quasi = node.quasis[index + 1];
          if (value === undefined || expressionValue === undefined || !quasi) {
            return undefined;
          }
          value += expressionValue + (quasi.value.cooked ?? quasi.value.raw);
        }
        return value;
      }
      if (node?.type === "BinaryExpression" && node.operator === "+") {
        const left = constantString(node.left);
        const right = constantString(node.right);
        if (left !== undefined && right !== undefined) {
          return left + right;
        }
      }
      return undefined;
    };

    const sourceValue = (node) => constantString(node);

    const staticPropertyName = (node) => {
      if (!node) {
        return undefined;
      }
      if (!node.computed && node.type === "Identifier") {
        return node.name;
      }
      return constantString(node);
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
        if (node.name === "require" && globalBinding(node, "require")) {
          return "require";
        }
        return hostBindings.get(bindingFor(node));
      }
      if (node.type === "MemberExpression") {
        if (hostKind(node.object) === "globalThis" && staticPropertyName(node.property) === "process") {
          return "process";
        }
        if (hostKind(node.object) === "globalThis" && staticPropertyName(node.property) === "require") {
          return "require";
        }
        if (hostKind(node.object) === "require" && staticPropertyName(node.property) === "bind") {
          return "require.bind";
        }
      }
      if (node.type === "CallExpression" && hostKind(node.callee) === "require.bind") {
        return "require";
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
        if (kind === "globalThis" && propertyName === "require") {
          markPattern(property.value, "require");
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
        const source = sourceValue(node.source);
        if (source === undefined) {
          reportDynamicModule(context, node.source);
        } else {
          reportForbiddenModule(context, node.source, source);
        }
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
        if (hostKind(node.callee) === "require") {
          const source = sourceValue(node.arguments[0]);
          if (source === undefined) {
            reportDynamicModule(context, node.arguments[0] ?? node.callee);
          } else {
            reportForbiddenModule(context, node.arguments[0], source);
          }
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

const clockBoundaryRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct wall-clock reads in core outside clock.ts",
    },
    schema: [],
  },
  create(context) {
    const filename = String(context.filename).replaceAll("\\", "/");
    const isClockModule = filename.endsWith("/src/core/clock.ts") || filename.endsWith("/src/core/clock.js");
    const isCanonicalModule = filename.endsWith("/src/core/canonical.ts") || filename.endsWith("/src/core/canonical.js");
    if (isClockModule) {
      return {};
    }

    const sourceCode = context.sourceCode;
    const hostBindings = new Map();
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

    const staticPropertyName = (node) => {
      if (node?.type === "Identifier") return node.name;
      if (node?.type === "Literal" && typeof node.value === "string") return node.value;
      return undefined;
    };

    const hostKind = (node) => {
      if (node?.type === "Identifier") {
        if (node.name === "Date") {
          const dateBinding = bindingFor(node);
          if (!dateBinding || dateBinding.defs.length === 0) return "Date";
        }
        if (node.name === "globalThis") {
          const globalBinding = bindingFor(node);
          if (!globalBinding || globalBinding.defs.length === 0) return "globalThis";
        }
        if (node.name === "require") {
          const requireBinding = bindingFor(node);
          if (!requireBinding || requireBinding.defs.length === 0) return "require";
        }
        return hostBindings.get(bindingFor(node));
      }
      if (
        node?.type === "MemberExpression" &&
        hostKind(node.object) === "globalThis" &&
        (staticPropertyName(node.property) === "Date" || staticPropertyName(node.property) === "require")
      ) {
        return staticPropertyName(node.property);
      }
      return undefined;
    };

    const markBinding = (node, kind) => {
      if (node?.type !== "Identifier") {
        return false;
      }
      const variable = bindingFor(node);
      if (variable) hostBindings.set(variable, kind);
      return true;
    };

    const markPattern = (pattern, kind) => {
      if (pattern?.type === "Identifier") {
        markBinding(pattern, kind);
        return;
      }
      if (pattern?.type === "AssignmentPattern") {
        markPattern(pattern.left, kind);
        return;
      }
      if (pattern?.type !== "ObjectPattern") return;
      for (const property of pattern.properties) {
        if (property.type !== "Property" || staticPropertyName(property.key) !== kind) continue;
        markPattern(property.value, kind);
      }
    };

    const markDatePattern = (pattern) => {
      if (pattern?.type === "Identifier") {
        markBinding(pattern, "Date");
        return;
      }
      if (pattern?.type === "AssignmentPattern") {
        markDatePattern(pattern.left);
        return;
      }
      if (pattern?.type !== "ObjectPattern") return;
      for (const property of pattern.properties) {
        if (property.type !== "Property" || staticPropertyName(property.key) !== "now") continue;
        markPattern(property.value, "DateNow");
      }
    };

    const markGlobalThisResult = (pattern) => {
      if (pattern?.type === "ObjectPattern") {
        markPattern(pattern, "Date");
        markPattern(pattern, "require");
      } else {
        markBinding(pattern, "globalThis");
      }
    };

    const isClockSpecifier = (node) => {
      const source = node?.type === "Literal" ? node : node?.source;
      if (source?.type !== "Literal" || typeof source.value !== "string") return false;
      return /(?:^|\/)clock(?:\.js|\.ts)?$/.test(source.value);
    };

    const reportsClockLoad = (node) => {
      context.report({ node, message: "src/core/canonical.ts must not load clock.ts" });
    };

    return {
      ImportDeclaration(node) {
        if (isCanonicalModule && isClockSpecifier(node)) reportsClockLoad(node.source);
      },
      ExportAllDeclaration(node) {
        if (isCanonicalModule && isClockSpecifier(node)) reportsClockLoad(node.source);
      },
      ExportNamedDeclaration(node) {
        if (isCanonicalModule && isClockSpecifier(node)) reportsClockLoad(node.source);
      },
      ImportExpression(node) {
        if (isCanonicalModule && isClockSpecifier(node)) reportsClockLoad(node.source);
      },
      VariableDeclarator(node) {
        const kind = hostKind(node.init);
        if (kind) {
          if (kind === "globalThis") {
            markGlobalThisResult(node.id);
          } else if (kind === "Date") {
            markDatePattern(node.id);
          } else {
            markPattern(node.id, kind);
          }
        }
      },
      AssignmentExpression(node) {
        const kind = hostKind(node.right);
        if (kind === "globalThis") {
          markGlobalThisResult(node.left);
        } else if (kind === "Date") {
          markDatePattern(node.left);
        } else if (kind) {
          markPattern(node.left, kind);
        }
      },
      MemberExpression(node) {
        if (
          staticPropertyName(node.property) === "now" &&
          hostKind(node.object) === "Date"
        ) {
          context.report({
            node,
            message: "Date.now() is only allowed in src/core/clock.ts",
          });
        }
      },
      CallExpression(node) {
        if (hostKind(node.callee) === "Date" && node.arguments.length === 0) {
          context.report({ node, message: "Zero-argument Date() is only allowed in src/core/clock.ts" });
        }
        if (hostKind(node.callee) === "DateNow") {
          context.report({ node, message: "Date.now() is only allowed in src/core/clock.ts" });
        }
        if (
          isCanonicalModule &&
          hostKind(node.callee) === "require" &&
          isClockSpecifier(node.arguments[0])
        ) {
          reportsClockLoad(node);
        }
      },
      NewExpression(node) {
        if (hostKind(node.callee) === "Date" && node.arguments.length === 0) {
          context.report({ node, message: "Zero-argument new Date() is only allowed in src/core/clock.ts" });
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
      dcompress: {
        rules: {
          "core-purity": corePurityRule,
          "clock-boundary": clockBoundaryRule,
        },
      },
    },
    rules: {
      "dcompress/core-purity": "error",
      "dcompress/clock-boundary": "error",
    },
  },
];
