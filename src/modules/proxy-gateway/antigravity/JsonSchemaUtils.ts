import { isBoolean, isEqual, isNumber, isPlainObject, isString } from 'lodash-es';
import { z } from 'zod';

const JsonValueSchema = z.json();
const JsonSchemaMapSchema = z.record(z.string(), JsonValueSchema);

type JsonSchemaValue = z.output<typeof JsonValueSchema>;

export type JsonSchemaMap = z.output<typeof JsonSchemaMapSchema>;

function isJsonSchemaMap(value: JsonSchemaValue): value is JsonSchemaMap {
  return isPlainObject(value);
}

function isJsonSchemaPrimitive(value: JsonSchemaValue): value is string | number | boolean {
  return isString(value) || isNumber(value) || isBoolean(value);
}

function inferConstSchemaType(value: JsonSchemaValue): string | undefined {
  if (isString(value)) {
    return 'string';
  }
  if (isNumber(value)) {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (isBoolean(value)) {
    return 'boolean';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (isJsonSchemaMap(value)) {
    return 'object';
  }
  return undefined;
}

function stringifyConstEnumValue(value: JsonSchemaValue): string {
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

  if (map.type === undefined) {
    const inferredType = inferConstSchemaType(constValue);
    if (inferredType) {
      map.type = inferredType;
    }
  }

  if (map.enum === undefined) {
    map.enum = [];
  }
  if (Array.isArray(map.enum) && !map.enum.some((entry) => isEqual(entry, constValue))) {
    map.enum.push(constValue);
  }

  return true;
}

function cloneJsonValue<TValue extends JsonSchemaValue>(value: TValue): TValue {
  return structuredClone(value);
}

function cloneJsonSchemaMap(value: JsonSchemaMap): JsonSchemaMap {
  const clonedValue = cloneJsonValue(value);
  return isJsonSchemaMap(clonedValue) ? clonedValue : {};
}

/**
 * Recursively cleans JSON Schema to meet Gemini interface requirements
 *
 * 1. [New] Flatten $ref and $defs: Replace references with actual definitions to solve Gemini's lack of $ref support
 * 2. Collapse allOf/anyOf/oneOf into the node so the declared shape survives removal
 * 3. Remove unsupported fields: $schema, additionalProperties, format, default, uniqueItems, validation fields
 * 3. Handle Union types: ["string", "null"] -> "string"
 * 4. Convert type field values to lowercase (Gemini v1internal requirement)
 * 5. Remove numeric validation fields: multipleOf, exclusiveMinimum, exclusiveMaximum, etc.
 */
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
        if (targetProperties[propertyName] === undefined) {
          targetProperties[propertyName] = propertySchema;
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

/**
 * Collapses allOf/anyOf/oneOf into the node before the hard blacklist deletes them.
 * Gemini rejects the keywords, but deleting them outright also deletes the only place a
 * schema declared its shape, so the tool arrives with no properties at all. `allOf` merges
 * every branch; `anyOf` and `oneOf` take the first branch that carries a shape.
 */
function collapseSchemaBranches(map: JsonSchemaMap) {
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
  // 0. Preprocessing: Expand $ref (Schema Flattening)
  if (isJsonSchemaMap(value)) {
    const defs: JsonSchemaMap = {};

    // Extract $defs or definitions
    if (value['$defs']) {
      if (isJsonSchemaMap(value['$defs'])) {
        Object.assign(defs, value['$defs']);
      }
      delete value['$defs'];
    }
    if (value['definitions']) {
      if (isJsonSchemaMap(value['definitions'])) {
        Object.assign(defs, value['definitions']);
      }
      delete value['definitions'];
    }

    if (Object.keys(defs).length > 0) {
      // Recursively replace references
      flattenRefs(value, defs);
    }
  }

  // Recursive cleaning
  cleanJsonSchemaRecursive(value);
}

export function normalizeObjectJsonSchema(schema: unknown): JsonSchemaMap {
  const fallbackSchema: JsonSchemaMap = { type: 'object', properties: {} };
  const parsedSchema = JsonSchemaMapSchema.safeParse(schema);
  if (!parsedSchema.success) {
    return fallbackSchema;
  }

  const normalizedSchema = cloneJsonSchemaMap(parsedSchema.data);
  cleanJsonSchema(normalizedSchema);

  if (!isString(normalizedSchema.type)) {
    normalizedSchema.type = 'object';
  }
  if (
    normalizedSchema.type === 'object' &&
    (!normalizedSchema.properties || !isJsonSchemaMap(normalizedSchema.properties))
  ) {
    normalizedSchema.properties = {};
  }

  return normalizedSchema;
}

/**
 * Recursively expand $ref
 */
function flattenRefs(value: JsonSchemaValue, defs: JsonSchemaMap): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      flattenRefs(entry, defs);
    }
    return;
  }

  if (!isJsonSchemaMap(value)) {
    return;
  }

  // Check and replace $ref
  if (isString(value['$ref'])) {
    const refPath = value['$ref'];
    // Parse reference name (e.g. #/$defs/MyType -> MyType)
    const parts = refPath.split('/');
    const refName = parts[parts.length - 1] || refPath;

    if (defs[refName]) {
      const defSchema = defs[refName];
      // $ref nodes should not have other properties, remove $ref directly
      delete value['$ref'];

      if (isJsonSchemaMap(defSchema)) {
        for (const [key, schemaValue] of Object.entries(defSchema)) {
          // Only insert if the key does not exist in current map (avoid overwrite)
          if (value[key] === undefined) {
            // Clone deep to avoid reference issues
            value[key] = cloneJsonValue(schemaValue);
          }
        }

        // Recursively process $refs in the newly merged content
        flattenRefs(value, defs);
      }
    }
  }

  // Recursively process all children
  for (const child of Object.values(value)) {
    flattenRefs(child, defs);
  }
}

function cleanJsonSchemaRecursive(value: JsonSchemaValue): void {
  if (Array.isArray(value)) {
    // Array: Recursively process each element
    for (const entry of value) {
      cleanJsonSchemaRecursive(entry);
    }
    return;
  }

  if (!isJsonSchemaMap(value)) {
    return;
  }

  const map = value;
  const hadConst = normalizeConstKeyword(map);

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

  // 1. Recursively process all children first to ensure nested structures are cleaned
  for (const child of Object.values(map)) {
    cleanJsonSchemaRecursive(child);
  }

  // 2. Collect and process validation fields (Migration logic: Downgrade constraints to Hints in description)
  const constraints: string[] = [];

  if (hadConst && Array.isArray(map.enum)) {
    map.enum = map.enum.map(stringifyConstEnumValue);
  }

  const enumValues = map.enum;
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues)) {
      delete map.enum;
    } else {
      const primitiveEnumValues = enumValues.filter(isJsonSchemaPrimitive);
      const schemaType = isString(map.type) ? map.type.toLowerCase() : '';
      const supportsGeminiStringEnum = ['string', 'integer', 'number'].includes(schemaType);

      if (primitiveEnumValues.length === 0) {
        delete map.enum;
      } else if (supportsGeminiStringEnum) {
        map.enum = primitiveEnumValues.map(String);
      } else if (primitiveEnumValues.every(isString)) {
        if (primitiveEnumValues.length !== enumValues.length) {
          map.enum = primitiveEnumValues;
        }
      } else {
        constraints.push(`enum: ${primitiveEnumValues.join(', ')}`);
        delete map.enum;
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
  collapseSchemaBranches(map);

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
}
