try {
  if (localStorage.getItem('recommend_auto_play') !== 'close') {
    localStorage.setItem('recommend_auto_play', 'close')
  }
} catch {
}
