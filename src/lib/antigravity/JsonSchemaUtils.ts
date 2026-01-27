/**
 * Recursively cleans JSON Schema to meet Gemini interface requirements
 *
 * 1. [New] Flatten $ref and $defs: Replace references with actual definitions to solve Gemini's lack of $ref support
 * 2. Remove unsupported fields: $schema, additionalProperties, format, default, uniqueItems, validation fields
 * 3. Handle Union types: ["string", "null"] -> "string"
 * 4. Convert type field values to lowercase (Gemini v1internal requirement)
 * 5. Remove numeric validation fields: multipleOf, exclusiveMinimum, exclusiveMaximum, etc.
 */
export function cleanJsonSchema(value: any) {
  // 0. Preprocessing: Expand $ref (Schema Flattening)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
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

/**
 * Recursively expand $ref
 */
function flattenRefs(map: any, defs: Record<string, any>) {
  if (!map || typeof map !== 'object') return;

  // 检查并替换 $ref
  if (typeof map['$ref'] === 'string') {
    const refPath = map['$ref'];
    // Parse reference name (e.g. #/$defs/MyType -> MyType)
    const parts = refPath.split('/');
    const refName = parts[parts.length - 1] || refPath;

    if (defs[refName]) {
      const defSchema = defs[refName];
      // $ref nodes should not have other properties, remove $ref directly
      delete map['$ref'];

      if (defSchema && typeof defSchema === 'object') {
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
      if (typeof v === 'object' && v !== null) {
        flattenRefs(v, defs);
      }
    }
  }
}

function cleanJsonSchemaRecursive(value: any) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    // Array: Recursively process each element
    for (const v of value) {
      cleanJsonSchemaRecursive(v);
    }
  } else {
    const map = value;

    // 1. Recursively process all children first to ensure nested structures are cleaned
    for (const k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        cleanJsonSchemaRecursive(map[k]);
      }
    }

    // 2. Collect and process validation fields (Migration logic: Downgrade constraints to Hints in description)
    const constraints: string[] = [];

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
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
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

    // 4. Physically remove "hard" blacklist items that interfere with generation
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
    ];
    for (const field of hardRemoveFields) {
      delete map[field];
    }

    // 5. Handle type field (Gemini requires single lowercase string)
    if (map['type']) {
      const typeVal = map['type'];
      if (typeof typeVal === 'string') {
        map['type'] = typeVal.toLowerCase();
      } else if (Array.isArray(typeVal)) {
        // Union type downgrade: take the first non-null type
        let selectedType = 'string';
        for (const item of typeVal) {
          if (typeof item === 'string' && item !== 'null') {
            selectedType = item.toLowerCase();
            break;
          }
        }
        map['type'] = selectedType;
      }
    }
  }
}
