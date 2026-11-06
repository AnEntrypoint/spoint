export default {
  server: {
    setup(ctx) {
      function nestedHelper(v) {
        return v + 1
      }
      ctx.state.value = nestedHelper(1)
    },
  },
}
