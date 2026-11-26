import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import FloatWindow from './FloatWindow'
import './styles.css'
import './ui-takeover.css'
import './floating.css'

declare global {
  interface Window {
    ds?: any
    dwFloat?: any
  }
}

const isFloatingWindow = new URLSearchParams(window.location.search).get('window') === 'float'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isFloatingWindow ? <FloatWindow /> : <App />}
  </React.StrictMode>
)
