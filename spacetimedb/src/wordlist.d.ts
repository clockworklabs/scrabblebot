// The module bundler (and our Vitest config) import `.txt` files as strings.
declare module "*.txt" {
  const text: string;
  export default text;
}
