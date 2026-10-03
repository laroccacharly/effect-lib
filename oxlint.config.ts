import { defineConfig } from "oxlint"

export default defineConfig({
  jsPlugins: ["ts-lint"],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    "ts-lint/no-unknown": "error",
    "ts-lint/effect-fn-return-type": "error",
    "ts-lint/no-undefined": "error",
  },
})
