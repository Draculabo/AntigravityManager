import type { OpenAITool } from '../server/interfaces/request-interfaces';

export interface SplitToolNamespace {
  name: string;
  namespace?: string;
}

export function qualifyNamespaceToolName(namespaceName: string, childName: string): string {
  const namespace = namespaceName.trim();
  const child = childName.trim();
  if (!namespace || !child || child.startsWith('mcp__') || child.startsWith(namespace)) {
    return child;
  }
  return namespace.endsWith('__') ? `${namespace}${child}` : `${namespace}__${child}`;
}

export function flattenOpenAITools(tools: OpenAITool[] | undefined): OpenAITool[] | undefined {
  if (!tools) {
    return undefined;
  }

  const flattened: OpenAITool[] = [];
  for (const tool of tools) {
    if (tool.type !== 'namespace') {
      flattened.push(tool);
      continue;
    }

    const namespace = typeof tool.name === 'string' ? tool.name : '';
    for (const child of flattenOpenAITools(tool.tools) ?? []) {
      const childName =
        typeof child.name === 'string'
          ? child.name
          : typeof child.function?.name === 'string'
            ? child.function.name
            : '';
      if (!childName) {
        flattened.push(child);
        continue;
      }

      const qualifiedName = qualifyNamespaceToolName(namespace, childName);
      flattened.push({
        ...child,
        ...(typeof child.name === 'string' ? { name: qualifiedName } : {}),
        ...(child.function
          ? {
              function: {
                ...child.function,
                name: qualifiedName,
              },
            }
          : {}),
      });
    }
  }
  return flattened;
}

export function splitNamespaceToolName(qualifiedName: string): SplitToolNamespace {
  const name = qualifiedName.trim();
  if (name.startsWith('mcp__')) {
    return { name };
  }

  const separatorIndex = name.indexOf('__');
  if (separatorIndex <= 0) {
    return { name };
  }
  return {
    name: name.slice(separatorIndex + 2),
    namespace: name.slice(0, separatorIndex),
  };
}
