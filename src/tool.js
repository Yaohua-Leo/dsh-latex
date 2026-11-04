/**
 * A tiny, dependency-free equivalent of `defineTool` from
 * `@deepseek-ai/dsh-tools`.
 *
 * A profile-installed bundle resolves its package imports from the DSH
 * installation, but a bundle linked from a workspace directory (the way this
 * plugin is installed during development) resolves imports from its own path.
 * To keep the same source installable either way, this plugin carries no
 * runtime import of a Harness package and compiles the small author-facing
 * parameter subset it actually uses into raw JSON Schema here.
 */

const ANNOTATIONS = new Set([
  'description',
  'title',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

function compileValue(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('tool schema must be an object');
  }
  const node = {};
  for (const [key, value] of Object.entries(input)) {
    if (ANNOTATIONS.has(key)) {
      node[key] = value;
      continue;
    }
    if (key === 'enum') {
      if (!Array.isArray(value) || value.length === 0) throw new Error('enum must be a non-empty array');
      node.enum = [...value];
      continue;
    }
    if (key === 'const') {
      node.const = value;
      continue;
    }
    if (key === 'type') {
      if (!['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'].includes(value)) {
        throw new Error(`unsupported schema type: ${String(value)}`);
      }
      if (value === 'json') continue; // annotation-only
      node.type = value;
      continue;
    }
    if (key === 'items') {
      node.items = compileValue(value);
      continue;
    }
    if (key === 'properties') {
      const compiled = compilePropertyMap(value);
      node.type = node.type ?? 'object';
      node.properties = compiled.properties;
      if (compiled.required) node.required = compiled.required;
      continue;
    }
    if (key === 'additionalProperties') {
      node.additionalProperties = value === true;
      continue;
    }
    if (key === 'oneOf') {
      if (!Array.isArray(value) || value.length < 2) throw new Error('oneOf needs at least two schemas');
      node.oneOf = value.map((entry) => compileValue(entry));
      continue;
    }
    if (key === 'required') continue; // author-only marker, collected by the caller
    // Unknown author keys are ignored rather than leaking into JSON Schema.
  }
  return node;
}

function compilePropertyMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('parameters must be an object of value schemas');
  }
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`parameter ${key} must be a value schema object`);
    }
    const { required: isRequired, ...schemaInput } = value;
    if (isRequired !== undefined && isRequired !== true) {
      throw new Error(`parameter ${key}.required must be true when present`);
    }
    properties[key] = compileValue(schemaInput);
    if (isRequired === true) required.push(key);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

function compileParameters(parameters) {
  const compiled = compilePropertyMap(parameters ?? {});
  const schema = { type: 'object', properties: compiled.properties };
  if (compiled.required) schema.required = compiled.required;
  return schema;
}

function typeMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

function validateValue(schema, value, path, violations) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !typeMatches(schema.type, value)) {
    violations.push(`${path || 'arguments'} must be ${schema.type}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path || 'arguments'} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`, violations));
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) violations.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) validateValue(child, value[key], path ? `${path}.${key}` : key, violations);
    }
  }
}

/**
 * Build a registry-ready tool definition from the author-facing subset.
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Record<string, object>} options.parameters
 * @param {{ schema: object, render: Function }} options.output
 * @param {Function} options.execute
 * @param {Function} [options.isConcurrencySafe]
 * @param {number} [options.timeoutMs]
 */
export function defineTool(options) {
  if (typeof options?.execute !== 'function') throw new Error(`defineTool(${options?.name}): execute is required`);
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }
  const parameters = compileParameters(options.parameters);
  const outputSchema = options.output?.schema ? compileValue(options.output.schema) : { type: 'string' };
  if (!options.output?.render) throw new Error(`defineTool(${options.name}): output.render is required`);
  const validate = (args) => {
    const violations = [];
    validateValue(
      { type: 'object', properties: parameters.properties, required: parameters.required },
      args,
      '',
      violations,
    );
    return violations;
  };
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) {
        const error = new Error(`invalid arguments: ${violations.join('; ')}`);
        error.name = 'ToolArgsError';
        error.code = 'INVALID_ARGS';
        error.violations = violations;
        throw error;
      }
      return options.execute(args, exec);
    },
    ...(typeof options.isConcurrencySafe === 'function'
      ? {
          isConcurrencySafe: (args) => (validate(args).length > 0 ? false : options.isConcurrencySafe(args)),
        }
      : {}),
  };
}
