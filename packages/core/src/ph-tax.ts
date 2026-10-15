import type { CartItem, Product } from "./types"

export interface TaxBreakdown {
  grossSales: number
  vatableSales: number
  vatAmount: number
  vatExemptSales: number
  zeroRatedSales: number
  totalDiscount: number
  netSales: number
}

/**
 * Philippine BIR Tax Constants & Logic
 */
export const VAT_RATE = 0.12

/**
 * Rounds a peso amount to centavos (half away from zero).
 * toPrecision(15) strips binary noise first, so 1.005 -> 1.01 (not 1.00).
 */
export function roundMoney(amount: number): number {
  const cents = Number((Math.abs(amount) * 100).toPrecision(15))
  return (Math.sign(amount) * Math.round(cents)) / 100
}

/**
 * Converts a peso amount to integer centavos for exact money comparisons.
 */
export function toCents(amount: number): number {
  return Math.round(roundMoney(amount) * 100)
}

/**
 * VAT removed from the SC/PWD share of a stored transaction: gross minus its VAT
 * breakdown parts. Lets a receipt show Subtotal - Less VAT - Less Discount = Total.
 * Returns undefined when there is none (no SC/PWD), so the receipt omits the line.
 */
export function lessVatOf(t: {
  gross_sales: number | string
  vatable_sales: number | string
  vat_amount: number | string
  vat_exempt_sales: number | string
  zero_rated_sales?: number | string | null
}): number | undefined {
  const lessVat = roundMoney(
    Number(t.gross_sales) - Number(t.vatable_sales) - Number(t.vat_amount) -
      Number(t.vat_exempt_sales) - Number(t.zero_rated_sales || 0)
  )
  return Number.isFinite(lessVat) && lessVat !== 0 ? lessVat : undefined
}

/**
 * Unit price charged for a line: the wholesale price once the quantity reaches the
 * product's wholesale threshold, otherwise the retail selling price.
 * Shared by the cart store and the sale route so both price a line identically.
 */
export function getActivePrice(
  product: Pick<Product, "selling_price" | "wholesale_price" | "wholesale_threshold">,
  quantity: number
): number {
  const threshold = Number(product.wholesale_threshold) || 0
  const wholesalePrice = Number(product.wholesale_price) || 0

  if (threshold > 0 && quantity >= threshold && wholesalePrice > 0) {
    return wholesalePrice
  }
  return Number(product.selling_price)
}

/**
 * Back-computes VAT from a gross price.
 * Formula: Net = Gross / (1 + VAT_RATE)
 */
export function getNetOfVAT(gross: number): number {
  return gross / (1 + VAT_RATE)
}

/**
 * Calculates the VAT amount from a gross price.
 */
export function getVATAmount(gross: number): number {
  return gross - getNetOfVAT(gross)
}

/**
 * Calculates the Senior Citizen / PWD Discount for an item.
 * Logic: 
 * 1. If VATABLE: Remove 12% VAT first, then apply 20% discount on the net share.
 * 2. If already EXEMPT: Just apply 20% discount on the share.
 * 3. Group Splitting: Discount applies only to the senior's portion (Share).
 */
export function calculateSCPWDDiscount(
  item: CartItem,
  paxCount: number,
  seniorCount: number
): number {
  const { product, quantity } = item
  const grossTotal = product.selling_price * quantity
  
  // 1. Get the Net Amount (Remove VAT if applicable)
  let netAmount = grossTotal
  if (product.tax_category === 'VATABLE') {
    netAmount = getNetOfVAT(grossTotal)
  }

  // 2. Calculate the Senior Share
  const seniorShare = (netAmount / paxCount) * seniorCount

  // 3. Apply 20% Discount on the share
  return seniorShare * 0.20
}

/**
 * Computes the full BIR-compliant tax breakdown for a transaction.
 *
 * Every money field is rounded to centavos, and the dependent fields are
 * derived from rounded parts so the printed figures always add up:
 *   netSales = vatableSales + vatAmount + vatExemptSales + zeroRatedSales - totalDiscount
 *   without SC/PWD: vatableSales + vatAmount + vatExemptSales + zeroRatedSales = grossSales
 *   vatableSales + vatAmount = the VAT-inclusive non-senior share of VATABLE lines
 * Each line's extended amount (price x qty) is rounded first, so grossSales is the
 * sum of the line amounts shown on the receipt.
 */
export function calculateTransactionTotals(
  items: CartItem[],
  paxCount: number = 1,
  seniorCount: number = 0
): TaxBreakdown {
  let grossSales = 0
  let vatableGross = 0 // VAT-inclusive
  let vatExemptGross = 0
  let zeroRatedGross = 0

  items.forEach((item) => {
    // Wholesale Logic Integration
    const activePrice = item.active_price !== undefined ? item.active_price : item.product.selling_price

    const itemGross = roundMoney(activePrice * item.quantity)
    grossSales += itemGross

    if (item.product.tax_category === 'VATABLE') {
      vatableGross += itemGross
    } else if (item.product.tax_category === 'VAT_EXEMPT') {
      vatExemptGross += itemGross
    } else if (item.product.tax_category === 'ZERO_RATED') {
      zeroRatedGross += itemGross
    }

    // Add individual product discounts (if any - to be expanded)
    if (item.product.is_promo && item.product.promo_price) {
        // Simple logic: if promo is better than SC discount, we'd need to compare.
        // For now, we focus on the mandatory SC/PWD logic.
    }
  });

  // Senior Share logic (group splitting): the seniors' portion of each line
  const seniorShare = seniorCount > 0 ? seniorCount / paxCount : 0

  // Non-senior portion of VATABLE lines remains vatable (split VAT-inclusive amount into net + VAT)
  const nonSeniorVatableGross = roundMoney(vatableGross * (1 - seniorShare))
  const vatableSales = roundMoney(getNetOfVAT(nonSeniorVatableGross))
  const vatAmount = roundMoney(nonSeniorVatableGross - vatableSales)

  // Senior portion of VATABLE lines becomes VAT exempt (12% VAT removed)
  const seniorVatableNet = roundMoney(getNetOfVAT(vatableGross - nonSeniorVatableGross))
  const vatExemptSales = roundMoney(vatExemptGross + seniorVatableNet)
  const zeroRatedSales = roundMoney(zeroRatedGross)

  // Apply the 20% SC/PWD discount on the seniors' net-of-VAT share
  const totalDiscount = seniorShare > 0
    ? roundMoney((seniorVatableNet + (vatExemptGross + zeroRatedGross) * seniorShare) * 0.20)
    : 0

  const netSales = roundMoney((vatableSales + vatAmount + vatExemptSales + zeroRatedSales) - totalDiscount)

  return {
    grossSales: roundMoney(grossSales),
    vatableSales,
    vatAmount,
    vatExemptSales,
    zeroRatedSales,
    totalDiscount,
    netSales
  }
}
