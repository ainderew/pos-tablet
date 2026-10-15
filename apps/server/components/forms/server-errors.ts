import type { FieldPath, FieldValues, UseFormSetError } from "react-hook-form"
import { ApiError, errorMessage } from "@/lib/api-client"

interface ServerErrorOptions<T extends FieldValues> {
  /** Form fields the server's zod issues may point at */
  fields: readonly FieldPath<T>[]
  /** Error codes that are about one field, e.g. { DUPLICATE_BARCODE: "barcode" } */
  codes?: Partial<Record<string, FieldPath<T>>>
  /** Server paths that a form field of another name stands for, e.g. { quantity_delta: "quantity" } */
  paths?: Partial<Record<string, FieldPath<T>>>
}

/**
 * Show a failed save on the form: a conflict or zod issue about a field goes under that field,
 * anything else becomes the form's own error (errors.root.server).
 */
export function showServerError<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>, opts: ServerErrorOptions<T>) {
  if (error instanceof ApiError) {
    const codeField = opts.codes?.[error.code]
    if (codeField) {
      setError(codeField, { type: "server", message: error.message }, { shouldFocus: true })
      return
    }
    if (error.issues.length) {
      const leftover: string[] = []
      for (const issue of error.issues) {
        const field = opts.paths?.[issue.path] ?? opts.fields.find((f) => issue.path === f || issue.path.startsWith(`${f}.`))
        if (field) setError(field, { type: "server", message: issue.message })
        else leftover.push(issue.path ? `${issue.path}: ${issue.message}` : issue.message)
      }
      if (leftover.length) setError("root.server", { type: "server", message: `${error.message}: ${leftover.join("; ")}` })
      return
    }
  }
  setError("root.server", { type: "server", message: errorMessage(error) })
}
