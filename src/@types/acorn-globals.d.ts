declare module 'acorn-globals' {
  import type { Node } from 'acorn'

  interface GlobalVariable {
    name: string
    nodes: Node[]
    // You can add more fields here as needed
  }

  function acornGlobals(ast: Node): GlobalVariable[]

  export = acornGlobals
}
