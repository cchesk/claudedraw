import './styles/tokens.css';
import './styles/app.css';
import { view } from './layout';
import { clearInput, state, type GameState } from './state';
import { initCharacter } from './screens/character';
import { initLocation, showLocation } from './screens/location';
import { initLoading, startLoading } from './screens/loading';
import { initExplore, enterExplore, leaveExplore, resizeExplore } from './screens/explore';

const stage = document.getElementById('stage')!;
const body = document.body;


/** Fixed 1280×800 stage on big screens, fluid full-screen layout otherwise (spec §4). */
function fit() {
  const fixed = innerWidth >= 900 && innerHeight >= 600;
  view.fluid = !fixed;
  body.classList.toggle('fluid', !fixed);
  view.stageScale = fixed ? Math.min(innerWidth / 1280, innerHeight / 800) : 1;
  stage.style.transform = fixed ? `translate(-50%,-50%) scale(${view.stageScale})` : '';
  if (state.screen === 'map') resizeExplore();
}

function setTouch(on: boolean) { state.touch = on; body.classList.toggle('touch', on); }

export function go(name: GameState['screen']) {
  const prev = state.screen;
  if (prev === 'map' && name !== 'map') leaveExplore();
  state.screen = name;
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === 's-' + name));
  clearInput();
  if (name === 'location') showLocation();
  if (name === 'loading') startLoading();
  if (name === 'map') { fit(); enterExplore(); }
}

setTouch(matchMedia('(pointer: coarse)').matches);
addEventListener('touchstart', () => setTouch(true), { passive: true, once: true });
addEventListener('resize', fit);
addEventListener('orientationchange', () => setTimeout(fit, 250));
window.visualViewport?.addEventListener('resize', fit);

initCharacter(go);
initLocation(go);
initLoading(go);
initExplore(go);
fit();
