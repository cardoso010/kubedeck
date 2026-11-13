/** Same keys as `T`, with any text: what a translation of an English area file must have. */
export type Translation<T> = { [K in keyof T]: T[K] extends string ? string : Translation<T[K]> };
