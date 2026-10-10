declare module 'lunar-javascript' {
  interface JieQi { getName(): string; getSolar(): SolarDay }
  interface SolarDay { getYear(): number; getMonth(): number; getDay(): number; getLunar(): Lunar }
  interface Lunar {
    getYearInGanZhi(): string
    getYearShengXiao(): string
    getMonthInChinese(): string
    getDayInChinese(): string
    getCurrentJieQi(): JieQi | null
    getNextJieQi(wholeDay?: boolean): JieQi
  }
  export const Solar: { fromDate(d: Date): SolarDay }
}
