import type { OpenAITool } from '../../../server/gateway/common/interfaces/request-interfaces';

export interface SplitToolNamespace {
  name: string;
  namespace?: string;
}

export function getOpenAIToolName(tool: OpenAITool): string | undefined {
  const name =
    (tool.type === 'custom' ? tool.custom?.name : undefined) ?? tool.function?.name ?? tool.name;
  return typeof name === 'string' ? name : undefined;
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
      const childName = getOpenAIToolName(child);
      if (!childName) {
        flattened.push(child);
        continue;
      }

      const qualifiedName = qualifyNamespaceToolName(namespace, childName);
      flattened.push({
        ...child,
        ...(typeof child.name === 'string' ? { name: qualifiedName } : {}),
        ...(child.custom ? { custom: { ...child.custom, name: qualifiedName } } : {}),
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

export function splitNamespaceToolName(
  qualifiedName: string,
  clientTools?: OpenAITool[],
): SplitToolNamespace {
  const name = qualifiedName.trim();
  // Declarations distinguish namespaced MCP calls from legacy flat mcp__ names.
  for (const tool of clientTools ?? []) {
    if (tool.type !== 'namespace' || !tool.name) {
      continue;
    }
    for (const child of flattenOpenAITools(tool.tools) ?? []) {
      const childName = getOpenAIToolName(child);
      if (childName && qualifyNamespaceToolName(tool.name, childName) === name) {
        return { name: childName, namespace: tool.name };
      }
    }
  }
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
