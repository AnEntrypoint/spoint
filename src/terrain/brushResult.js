export function brushRejected(field) {
  return { rejected: true, field, touched: 0 }
}

export function brushApplied(touched) {
  return { rejected: false, touched }
}
