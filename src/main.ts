import { mount } from 'svelte';
// Only 300–600 are bundled; heavier weights in components resolve to 600, which keeps Poppins from looking too bold.
import '@fontsource/poppins/300.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import './app.css';
import App from './App.svelte';
import { initExternalLinkHandler } from './lib/open-external';

initExternalLinkHandler();

export default mount(App, { target: document.getElementById('app')! });

