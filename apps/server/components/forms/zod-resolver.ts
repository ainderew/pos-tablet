// react-hook-form resolver for zod 4. (@hookform/resolvers 3.x only understands zod 3's errors: with
// zod 4 it throws instead of returning field errors.)
import type { FieldError, FieldErrors, FieldValues, Resolver } from "react-hook-form"
import type { z } from "zod"

export function zodResolver<Schema extends z.ZodType<FieldValues, FieldValues>>(
  schema: Schema
): Resolver<z.input<Schema>, unknown, z.output<Schema>> {
  return async (values) => {
    const result = await schema.safeParseAsync(values)
    if (result.success) return { values: result.data, errors: {} }

    const errors: Record<string, unknown> = {}
    for (const issue of result.error.issues) {
      const path = issue.path.length ? issue.path.map(String) : ["root"]
      let node = errors
      for (const key of path.slice(0, -1)) {
        node[key] = (node[key] as Record<string, unknown>) ?? {}
        node = node[key] as Record<string, unknown>
      }
      const leaf = path[path.length - 1]
      // The first problem with a field is the one shown
      if (!node[leaf]) node[leaf] = { type: issue.code, message: issue.message } satisfies FieldError
    }
    return { values: {}, errors: errors as FieldErrors<z.input<Schema>> }
  }
}
