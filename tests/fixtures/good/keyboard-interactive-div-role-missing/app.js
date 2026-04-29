document.querySelector('.action').addEventListener('click', () => {
  save();
});

const trigger = document.getElementById('trigger');
trigger.onclick = () => openMenu();
