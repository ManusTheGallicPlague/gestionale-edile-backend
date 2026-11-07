/** VAT rates accepted on quote lines, in percent. */
export const VAT_RATES = [22, 10, 5, 4, 0] as const

/**
 * Natures of a zero-rated operation, with the codes of the Italian e-invoice (SDI), and the
 * wording printed on the PDF. N6.3 and N6.7 are the reverse charge of the building trade.
 */
export const VAT_NATURES = {
  N1: 'Escluse ex art. 15 DPR 633/72',
  'N2.1': 'Non soggette ad IVA ai sensi degli artt. da 7 a 7-septies del DPR 633/72',
  'N2.2': 'Non soggette ad IVA, altri casi',
  'N3.1': 'Non imponibili, esportazioni',
  'N3.2': 'Non imponibili, cessioni intracomunitarie',
  'N3.3': 'Non imponibili, cessioni verso San Marino',
  'N3.4': "Non imponibili, operazioni assimilate alle cessioni all'esportazione",
  'N3.5': "Non imponibili, a seguito di dichiarazioni d'intento",
  'N3.6': 'Non imponibili, altre operazioni',
  N4: 'Esenti',
  N5: 'Regime del margine, IVA non esposta in fattura',
  'N6.1': 'Inversione contabile, cessione di rottami e altri materiali di recupero',
  'N6.2': 'Inversione contabile, cessione di oro e argento',
  'N6.3': 'Inversione contabile, subappalto nel settore edile (art. 17, c. 6, lett. a, DPR 633/72)',
  'N6.4': 'Inversione contabile, cessione di fabbricati',
  'N6.5': 'Inversione contabile, cessione di telefoni cellulari',
  'N6.6': 'Inversione contabile, cessione di prodotti elettronici',
  'N6.7':
    'Inversione contabile, prestazioni comparto edile e settori connessi (art. 17, c. 6, lett. a-ter, DPR 633/72)',
  'N6.8': 'Inversione contabile, operazioni del settore energetico',
  'N6.9': 'Inversione contabile, altri casi',
  N7: 'IVA assolta in altro stato UE',
} as const

export type VatNature = keyof typeof VAT_NATURES

export const isVatNature = (value: unknown): value is VatNature =>
  typeof value === 'string' && Object.hasOwn(VAT_NATURES, value)
