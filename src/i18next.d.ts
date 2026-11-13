// Types `t()` against the English strings, so an unknown key fails `tsc`.
import "i18next";
import type en from "./locales/en";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
