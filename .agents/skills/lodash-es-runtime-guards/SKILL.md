# lodash-es-runtime-guards

Replace runtime `typeof` checks and ad-hoc empty-string checks with `lodash-es` predicates.

## When to Use

- You see runtime checks like `typeof value === 'string'`.
- You see object guards like `value && typeof value === 'object'`.
- You see emptiness checks like `value.trim() !== ''` or `value.trim() === ''`.
- You want consistent guard style across app, server, IPC, and tests.

## Do Not Replace

- Type-level `typeof` (TypeScript only), for example:
  - `ReturnType<typeof fn>`
  - `keyof typeof CONST_MAP`
  - `z.infer<typeof Schema>`

These are compile-time types and must remain as-is.

## Guard Mapping

- `typeof x === 'string'` -> `isString(x)`
- `typeof x !== 'string'` -> `!isString(x)`
- `typeof x === 'number'` -> `isNumber(x)`
- `typeof x === 'boolean'` -> `isBoolean(x)`
- `typeof x === 'function'` -> `isFunction(x)`
- `typeof x === 'undefined'` -> `isUndefined(x)`
- `x && typeof x === 'object'` -> `isObjectLike(x)`
- `typeof x === 'object' && x !== null` -> `isObjectLike(x)`
- `typeof x === 'object' && !Array.isArray(x)` -> `isObjectLike(x) && !isArray(x)`

## String Emptiness Pattern

- Prefer:
  - `isEmpty(value.trim())`
- Instead of:
  - `value.trim() === ''`
  - `value.trim() !== ''`
  - `value.trim().length === 0`

## Import Style

- Use named imports from `lodash-es`:

```ts
import { isString, isNumber, isObjectLike, isEmpty } from 'lodash-es';
```

- Do not use full-package imports.
- Reuse existing imports in file; avoid duplicate imports.

## Refactor Checklist

1. Replace runtime checks first, preserving behavior.
2. Keep array/object branching semantics unchanged.
3. Re-scan:

```bash
rg -n "typeof\s+[^\n]+(?:===|!==)\s*'" src
```

4. Confirm only type-level `typeof` remains:

```bash
rg -n "\btypeof\b" src
```

5. Run verification:

```bash
npm run type-check
```

