import { isBoolean, isEqual, isNumber, isPlainObject, isString } from 'lodash-es';
import {
  SchemaConversionBatch,
  SchemaInputError,
  validateSchemaInput,
  type JsonValue as JsonSchemaValue,
  type JsonSchemaMap,
} from './schema/SchemaConversion';
import {
  resolveSchemaReferences,
  recordTerminalSchemaIssue,
} from './schema/JsonSchemaReferenceResolver';
export type { JsonSchemaMap } from './schema/SchemaConversion';

function isJsonSchemaMap(value: JsonSchemaValue): value is JsonSchemaMap {
  return isPlainObject(value);
}

function isJsonSchemaPrimitive(value: JsonSchemaValue): value is string | number | boolean {
  return isString(value) || isNumber(value) || isBoolean(value);
}

function stringifyEnumValue(value: JsonSchemaValue): string {
  if (isString(value)) {
    return value;
  }
  if (value === null) {
    return 'null';
  }
  return JSON.stringify(value);
}

function normalizeConstKeyword(map: JsonSchemaMap): boolean {
  if (!Object.prototype.hasOwnProperty.call(map, 'const')) {
    return false;
  }

  const constValue = map.const;
  delete map.const;
  map.type = 'string';

  if (map.enum === undefined) {
    map.enum = [];
  }
  if (Array.isArray(map.enum) && !map.enum.some((entry) => isEqual(entry, constValue))) {
    map.enum.push(constValue);
  }

  return true;
}

/**
 * Merges a branch schema into the node, keeping whatever the node already declares.
 * `properties` merge key by key and `required` unions, so nothing already present is
 * overwritten by a branch.
 */
function mergeSchemaInto(target: JsonSchemaMap, source: JsonSchemaMap) {
  for (const [key, val] of Object.entries(source)) {
    if (key === 'properties' && isJsonSchemaMap(val)) {
      const targetProperties = isJsonSchemaMap(target.properties) ? target.properties : {};
      target.properties = targetProperties;
      for (const [propertyName, propertySchema] of Object.entries(val)) {
        if (!Object.hasOwn(targetProperties, propertyName)) {
          Object.defineProperty(targetProperties, propertyName, {
            value: propertySchema,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      continue;
    }

    if (key === 'required' && Array.isArray(val)) {
      const existing = Array.isArray(target.required) ? target.required : [];
      target.required = Array.from(new Set([...existing, ...val]));
      continue;
    }

    if (target[key] === undefined) {
      target[key] = val;
    }
  }
}

function isObjectAlternative(branch: JsonSchemaValue): branch is JsonSchemaMap {
  return (
    isJsonSchemaMap(branch) &&
    (branch.type === 'object' || (branch.type === undefined && isJsonSchemaMap(branch.properties))) &&
    branch.allOf === undefined && branch.anyOf === undefined && branch.oneOf === undefined &&
    branch.const === undefined && branch.enum === undefined
  );
}

function mergeAlternativeProperty(left: JsonSchemaValue, right: JsonSchemaValue): JsonSchemaValue {
  if (isEqual(left, right)) {
    return left;
  }
  if (isObjectAlternative(left) && isObjectAlternative(right)) {
    return mergeObjectAlternatives([left, right]);
  }
  if (isJsonSchemaMap(left) && isJsonSchemaMap(right)) {
    // The recursive cleanup has already normalized both branch enums to strings.
    if (Array.isArray(left.enum) && Array.isArray(right.enum)) {
      return { type: 'string', enum: [...new Set([...left.enum, ...right.enum])] };
    }
    if (left.type === 'array' && right.type === 'array'
        && isJsonSchemaMap(left.items) && isJsonSchemaMap(right.items)) {
      return { type: 'array', items: mergeAlternativeProperty(left.items, right.items) };
    }
    if (isString(left.type) && left.type === right.type && left.type !== 'array') {
      return { type: left.type };
    }
  }
  // Gemini needs a concrete property type when the alternatives have incompatible shapes.
  return left;
}

/** Project object alternatives to a property superset with only unconditional requirements. */
function mergeObjectAlternatives(branches: JsonSchemaMap[]): JsonSchemaMap {
  const properties = new Map<string, JsonSchemaValue>();
  let required: JsonSchemaValue[] | undefined;
  for (const branch of branches) {
    const branchRequired = Array.isArray(branch.required) ? branch.required : [];
    required = required ? required.filter((key) => branchRequired.includes(key)) : branchRequired;
    if (isJsonSchemaMap(branch.properties)) {
      for (const [name, schema] of Object.entries(branch.properties)) {
        const previous = properties.get(name);
        properties.set(name, previous === undefined ? schema : mergeAlternativeProperty(previous, schema));
      }
    }
  }
  return {
    type: 'object',
    properties: Object.fromEntries(properties),
    ...(required?.length ? { required } : {}),
  };
}

/** Keep representable shapes before removing composition keywords unsupported by Gemini. */
function collapseSchemaBranches(map: JsonSchemaMap, policy: 'tool' | 'output' | 'compatibility') {
  const allOf = map['allOf'];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (isJsonSchemaMap(branch)) {
        mergeSchemaInto(map, branch);
      }
    }
  }

  for (const keyword of ['anyOf', 'oneOf']) {
    const branches = map[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    if (policy !== 'output' && branches.length > 1 && branches.every(isObjectAlternative)) {
      mergeSchemaInto(map, mergeObjectAlternatives(branches));
      continue;
    }
    const usable = branches.find(
      (branch): branch is JsonSchemaMap =>
        isJsonSchemaMap(branch) && (branch.properties !== undefined || branch.type !== undefined),
    );
    if (usable) {
      mergeSchemaInto(map, usable);
    }
  }
}

export function cleanJsonSchema(value: JsonSchemaMap): void {
  const batch = new SchemaConversionBatch();
  validateSchemaInput(value, batch);
  const resolved = resolveSchemaReferences(value, batch, 'compatibility', null);
  for (const key of Object.keys(value)) {
    delete value[key];
  }
  Object.assign(value, resolved);
  cleanJsonSchemaRecursive(value);
}

export function normalizeObjectJsonSchema(
  schema: unknown,
  batch = new SchemaConversionBatch(),
  policy: 'tool' | 'output' = 'tool',
  toolOrdinal: number | null = null,
): JsonSchemaMap {
  try {
    const input =
      schema === undefined && policy === 'tool' ? { type: 'object', properties: {} } : schema;
    validateSchemaInput(input, batch);
    const normalizedSchema = resolveSchemaReferences(input, batch, policy, toolOrdinal);
    cleanJsonSchemaRecursive(normalizedSchema, policy);
    if (!isString(normalizedSchema.type)) {
      normalizedSchema.type = 'object';
    }
    if (policy === 'tool' && normalizedSchema.type !== 'object') {
      throw new SchemaInputError('invalid-root');
    }
    if (normalizedSchema.type === 'object' && !isJsonSchemaMap(normalizedSchema.properties)) {
      normalizedSchema.properties = {};
    }
    // Compatibility cleanup can add descriptions or stringify const data. Charge its final result.
    validateSchemaInput(normalizedSchema, batch, 'output');
    return normalizedSchema;
  } catch (error) {
    recordTerminalSchemaIssue(batch, error, toolOrdinal);
    throw error;
  }
}

function cleanJsonSchemaRecursive(
  value: JsonSchemaValue,
  policy: 'tool' | 'output' | 'compatibility' = 'compatibility',
): void {
  if (Array.isArray(value)) {
    // Array: Recursively process each element
    for (const entry of value) {
      cleanJsonSchemaRecursive(entry, policy);
    }
    return;
  }

  if (!isJsonSchemaMap(value)) {
    return;
  }

  const map = value;
  normalizeConstKeyword(map);

  if (isJsonSchemaMap(map.properties)) {
    const properties = map.properties;
    const droppedKeys = Object.keys(properties).filter((key) => !isJsonSchemaMap(properties[key]));

    for (const key of droppedKeys) {
      delete properties[key];
    }

    const requiredFields = map.required;
    if (droppedKeys.length > 0 && Array.isArray(requiredFields)) {
      const remainingRequiredFields = requiredFields.filter(
        (requiredKey) => !isString(requiredKey) || !droppedKeys.includes(requiredKey),
      );
      if (remainingRequiredFields.length === 0) {
        delete map.required;
      } else {
        map.required = remainingRequiredFields;
      }
    }
  }

  if (map.items !== undefined && !isJsonSchemaMap(map.items)) {
    delete map.items;
  }

  // Literal data (const/enum/default/examples) is not a schema traversal edge.
  if (isJsonSchemaMap(map.properties)) {
    for (const child of Object.values(map.properties)) {
      cleanJsonSchemaRecursive(child, policy);
    }
  }
  if (isJsonSchemaMap(map.items)) {
    cleanJsonSchemaRecursive(map.items, policy);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(map[keyword])) {
      cleanJsonSchemaRecursive(map[keyword], policy);
    }
  }

  // 2. Collect and process validation fields (Migration logic: Downgrade constraints to Hints in description)
  const constraints: string[] = [];

  const enumValues = map.enum;
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues)) {
      delete map.enum;
    } else {
      const stringEnumValues = enumValues.map(stringifyEnumValue).filter((entry) => entry !== '');
      if (stringEnumValues.length === 0) {
        delete map.enum;
      } else {
        map.enum = stringEnumValues;
        map.type = 'string';
      }
    }
  }

  // Validation fields blacklist for migration
  const validationFields = [
    ['pattern', 'pattern'],
    ['minLength', 'minLen'],
    ['maxLength', 'maxLen'],
    ['minimum', 'min'],
    ['maximum', 'max'],
    ['minItems', 'minItems'],
    ['maxItems', 'maxItems'],
    ['exclusiveMinimum', 'exclMin'],
    ['exclusiveMaximum', 'exclMax'],
    ['multipleOf', 'multipleOf'],
    ['format', 'format'],
  ];

  for (const [field, label] of validationFields) {
    const validationValue = map[field];
    // Only migrate if value is primitive type
    if (isJsonSchemaPrimitive(validationValue)) {
      constraints.push(`${label}: ${validationValue}`);
      delete map[field];
    }
  }

  // 3. Append constraint info to description
  if (constraints.length > 0) {
    const suffix = ` [Constraint: ${constraints.join(', ')}]`;
    map['description'] = String(map['description'] || '') + suffix;
  }

  // 4. Keep the declared shape before the blacklist removes the keyword that carried it
  collapseSchemaBranches(map, policy);

  const schemaType = map.type;
  if (isString(schemaType) && schemaType.toLowerCase() === 'array' && map.items === undefined) {
    map.items = { type: 'string' };
  }

  // 5. Physically remove "hard" blacklist items that interfere with generation
  const hardRemoveFields = [
    '$schema',
    'additionalProperties',
    'enumCaseInsensitive',
    'enumNormalizeWhitespace',
    'uniqueItems',
    'default',
    'examples',
    // Advanced logic fields common in MCP tools but unsupported by Gemini
    'propertyNames',
    'anyOf',
    'oneOf',
    'allOf',
    'not',
    'if',
    'then',
    'else',
    'dependencies',
    'dependentSchemas',
    'dependentRequired',
    'cache_control', // Fixes 400 error triggered by user report
    'tools',
  ];
  for (const field of hardRemoveFields) {
    delete map[field];
  }

  // 6. Handle type field (Gemini requires single lowercase string)
  if (map['type']) {
    const typeValue = map['type'];
    if (isString(typeValue)) {
      map['type'] = typeValue.toLowerCase();
    } else if (Array.isArray(typeValue)) {
      // Union type downgrade: take the first non-null type
      let selectedType = 'string';
      for (const item of typeValue) {
        if (isString(item) && item !== 'null') {
          selectedType = item.toLowerCase();
          break;
        }
      }
      map['type'] = selectedType;
    }
  }
  if (policy === 'tool' && map.type === 'array') {
    delete map.properties;
    // An untyped element with its own item schema can describe another array dimension.
    let element = map.items;
    while (
      isJsonSchemaMap(element) &&
      element.type === undefined &&
      element.properties === undefined &&
      element.required === undefined &&
      isJsonSchemaMap(element.items)
    ) {
      element.type = 'array';
      element = element.items;
    }
  }
}
