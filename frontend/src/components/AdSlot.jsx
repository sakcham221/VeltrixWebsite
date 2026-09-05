import { isAdEnabled } from '../ads';

export default function AdSlot({ position, size = 'responsive' }) {
  const adsEnabled = isAdEnabled();

  return (
    <div
      className={`ad-slot ad-slot--${position} ad-slot--${size} ${!adsEnabled ? 'ad-slot--placeholder' : ''}`}
      aria-label={`${position} advertisement slot`}
      role="complementary"
      aria-hidden={false}
    >
      {adsEnabled ? <div className="ad-slot__content" /> : <div className="ad-slot__content ad-slot__content--blank" />}
    </div>
  );
}
