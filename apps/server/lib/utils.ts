import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Tailwind class merging (shadcn convention) */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
