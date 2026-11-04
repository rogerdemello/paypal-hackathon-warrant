import { useState } from 'react';
import type { ProductRowDto } from '@warrant/server/api-types';
import { api } from '../../api';
import { Badge, Card, ErrorNote, Hash, Spinner } from '../../components/ui';
import { money, words } from '../../format';
import { useAction, useLoad } from '../../hooks';

/**
 * The merchant's own catalog. The verifier prices every cart from here, never from the cart, so changing a price or a listing
 * after a customer has approved a cart is a fast way to see rule V08 refuse it.
 */
export function Catalog() {
  const products = useLoad(() => api.console.products(), []);
  const [filter, setFilter] = useState('');
  if (products.data === null) return products.error === null ? <Spinner /> : <ErrorNote error={products.error} onRetry={products.reload} />;
  const rows = products.data.products.filter((p) => p.title.toLowerCase().includes(filter.toLowerCase()) || p.category.includes(filter.toLowerCase()));
  return (
    <Card
      title="Catalog"
      actions={<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter products" />}
    >
      <p className="muted small">
        Edit a price or take an item off sale. The listing fingerprint changes with every edit, so any cart built from the old listing stops matching.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th className="right">Price</th>
              <th>On sale</th>
              <th>Listing fingerprint</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <ProductRow key={`${p.sku}-${p.listingHash}`} product={p} onSaved={products.reload} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ProductRow({ product, onSaved }: { product: ProductRowDto; onSaved: () => void }) {
  const [price, setPrice] = useState((product.priceCents / 100).toFixed(2));
  const [available, setAvailable] = useState(product.available);
  const save = useAction(async () => {
    await api.console.patchProduct(product.sku, { priceCents: Math.round(Number(price) * 100), available });
    onSaved();
  });
  const cents = Math.round(Number(price) * 100);
  const changed = cents !== product.priceCents || available !== product.available;
  return (
    <tr>
      <td>
        {product.title}
        <div className="muted small mono">{product.sku}</div>
      </td>
      <td>
        <Badge tone={['gift_cards', 'prepaid_cards', 'crypto', 'gambling', 'adult'].includes(product.category) ? 'bad' : 'neutral'}>{words(product.category)}</Badge>
      </td>
      <td className="right">
        <input value={price} onChange={(e) => setPrice(e.target.value)} aria-label={`Price of ${product.title}`} inputMode="decimal" style={{ width: 90, textAlign: 'right' }} />
        <div className="muted small">now {money(product.priceCents, product.currency)}</div>
      </td>
      <td>
        <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} aria-label={`${product.title} on sale`} />
      </td>
      <td>
        <Hash value={product.listingHash} keep={6} />
      </td>
      <td>
        <button className="small" disabled={!changed || !Number.isFinite(cents) || cents <= 0 || save.busy} onClick={() => void save.run()}>
          Save
        </button>
        <ErrorNote error={save.error} />
      </td>
    </tr>
  );
}
