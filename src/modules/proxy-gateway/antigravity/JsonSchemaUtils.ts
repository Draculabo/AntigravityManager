import { isArray, isBoolean, isNumber, isObjectLike, isString } from 'lodash-es';

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
function mergeSchemaInto(target: Record<string, any>, source: Record<string, any>) {
  for (const [key, val] of Object.entries(source)) {
    if (key === 'properties' && isObjectLike(val) && !isArray(val)) {
      if (!isObjectLike(target.properties) || isArray(target.properties)) {
        target.properties = {};
      }
      const targetProperties = target.properties as Record<string, unknown>;
      for (const [propertyName, propertySchema] of Object.entries(val)) {
        if (targetProperties[propertyName] === undefined) {
          targetProperties[propertyName] = propertySchema;
        }
      }
      continue;
    }

    if (key === 'required' && isArray(val)) {
      const existing = isArray(target.required) ? (target.required as unknown[]) : [];
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
function collapseSchemaBranches(map: Record<string, any>) {
  const allOf = map['allOf'];
  if (isArray(allOf)) {
    for (const branch of allOf) {
      if (isObjectLike(branch) && !isArray(branch)) {
        mergeSchemaInto(map, branch as Record<string, any>);
      }
    }
  }

  for (const keyword of ['anyOf', 'oneOf']) {
    const branches = map[keyword];
    if (!isArray(branches)) {
      continue;
    }
    const usable = branches.find(
      (branch) =>
        isObjectLike(branch) &&
        !isArray(branch) &&
        ((branch as Record<string, unknown>).properties !== undefined ||
          (branch as Record<string, unknown>).type !== undefined),
    );
    if (usable) {
      mergeSchemaInto(map, usable as Record<string, any>);
    }
  }
}

export function cleanJsonSchema(value: any) {
  // 0. Preprocessing: Expand $ref (Schema Flattening)
  if (isObjectLike(value) && !isArray(value)) {
    const defs: Record<string, any> = {};

    // Extract $defs or definitions
    if (value['$defs']) {
      Object.assign(defs, value['$defs']);
      delete value['$defs'];
    }
    if (value['definitions']) {
      Object.assign(defs, value['definitions']);
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

export function normalizeObjectJsonSchema(schema: unknown): Record<string, unknown> {
  const fallbackSchema: Record<string, unknown> = { type: 'object', properties: {} };
  if (!isObjectLike(schema) || isArray(schema)) {
    return fallbackSchema;
  }

  const normalizedSchema = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  cleanJsonSchema(normalizedSchema);

  if (!isString(normalizedSchema.type)) {
    normalizedSchema.type = 'object';
  }
  if (
    normalizedSchema.type === 'object' &&
    (!normalizedSchema.properties ||
      !isObjectLike(normalizedSchema.properties) ||
      isArray(normalizedSchema.properties))
  ) {
    normalizedSchema.properties = {};
  }

  return normalizedSchema;
}

/**
 * Recursively expand $ref
 */
function flattenRefs(map: any, defs: Record<string, any>) {
  if (!isObjectLike(map)) return;

  // Check and replace $ref
  if (isString(map['$ref'])) {
    const refPath = map['$ref'];
    // Parse reference name (e.g. #/$defs/MyType -> MyType)
    const parts = refPath.split('/');
    const refName = parts[parts.length - 1] || refPath;

    if (defs[refName]) {
      const defSchema = defs[refName];
      // $ref nodes should not have other properties, remove $ref directly
      delete map['$ref'];

      if (isObjectLike(defSchema)) {
        for (const [k, v] of Object.entries(defSchema)) {
          // Only insert if the key does not exist in current map (avoid overwrite)
          if (map[k] === undefined) {
            // Clone deep to avoid reference issues
            map[k] = JSON.parse(JSON.stringify(v));
          }
        }

        // Recursively process $refs in the newly merged content
        flattenRefs(map, defs);
      }
    }
  }

  // Recursively process all children
  for (const k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      const v = map[k];
      if (isObjectLike(v)) {
        flattenRefs(v, defs);
      }
    }
  }
}

function cleanJsonSchemaRecursive(value: any) {
  if (!isObjectLike(value)) {
    return;
  }

  if (isArray(value)) {
    // Array: Recursively process each element
    for (const v of value) {
      cleanJsonSchemaRecursive(v);
    }
  } else {
    const map = value;

    if (isObjectLike(map.properties) && !isArray(map.properties)) {
      const properties = map.properties as Record<string, unknown>;
      const droppedKeys = Object.keys(properties).filter(
        (key) => !isObjectLike(properties[key]) || isArray(properties[key]),
      );

      for (const key of droppedKeys) {
        delete properties[key];
      }

      if (droppedKeys.length > 0 && isArray(map.required)) {
        map.required = map.required.filter(
          (requiredKey: unknown) => !isString(requiredKey) || !droppedKeys.includes(requiredKey),
        );
        if (map.required.length === 0) {
          delete map.required;
        }
      }
    }

    if (map.items !== undefined && (!isObjectLike(map.items) || isArray(map.items))) {
      delete map.items;
      // 1. Recursively process all children first to ensure nested structures are cleaned
    }
    for (const k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        cleanJsonSchemaRecursive(map[k]);
      }
    }

    // 2. Collect and process validation fields (Migration logic: Downgrade constraints to Hints in description)
    const constraints: string[] = [];

    const enumValues = map.enum;
    if (enumValues !== undefined) {
      if (!isArray(enumValues)) {
        delete map.enum;
      } else {
        const primitiveEnumValues = enumValues.filter(
          (enumValue: unknown) =>
            isString(enumValue) || isNumber(enumValue) || isBoolean(enumValue),
        );

        if (primitiveEnumValues.length === 0) {
          delete map.enum;
        } else if (isString(map.type) && map.type.toLowerCase() === 'string') {
          if (
            primitiveEnumValues.length !== enumValues.length ||
            !primitiveEnumValues.every(isString)
          ) {
            map.enum = primitiveEnumValues.map(String);
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
      if (map[field] !== undefined) {
        const val = map[field];
        // Only migrate if value is primitive type
        if (isString(val) || isNumber(val) || isBoolean(val)) {
          constraints.push(`${label}: ${val}`);
          delete map[field];
        } else {
          // If not expected type, leave as is (JS pass by reference, just don't delete)
        }
      }
    }

    // 3. Append constraint info to description
    if (constraints.length > 0) {
      const suffix = ` [Constraint: ${constraints.join(', ')}]`;
      map['description'] = (map['description'] || '') + suffix;
    }

    // 4. Keep the declared shape before the blacklist removes the keyword that carried it
    collapseSchemaBranches(map);

    // 5. Physically remove "hard" blacklist items that interfere with generation
    const hardRemoveFields = [
      '$schema',
      'additionalProperties',
      'enumCaseInsensitive',
      'enumNormalizeWhitespace',
      'uniqueItems',
      'default',
      'const',
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
      'cache_control', // Fixes 400 error triggered by cache_control mentioned by user
      'tools',
    ];
    for (const field of hardRemoveFields) {
      delete map[field];
    }

    // 5. Handle type field (Gemini requires single lowercase string)
    if (map['type']) {
      const typeVal = map['type'];
      if (isString(typeVal)) {
        map['type'] = typeVal.toLowerCase();
      } else if (isArray(typeVal)) {
        // Union type downgrade: take the first non-null type
        let selectedType = 'string';
        for (const item of typeVal) {
          if (isString(item) && item !== 'null') {
            selectedType = item.toLowerCase();
            break;
          }
        }
        map['type'] = selectedType;
      }
    }
  }
}
