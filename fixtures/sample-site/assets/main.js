const waterButton = document.querySelector('#water');
const waterStatus = document.querySelector('#water-status');
let drops = 0;

waterButton.addEventListener('click', () => {
  drops += 1;
  waterStatus.textContent = drops === 1
    ? 'One drop added. The garden says thank you!'
    : `${drops} drops added. The garden is growing!`;
});
