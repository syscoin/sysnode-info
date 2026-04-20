import axios from 'axios';

const client = axios.create({
  baseURL: 'https://syscoin.dev',
  headers: {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
  },
  timeout: 15000,
});

export async function fetchNetworkStats() {
  const response = await client.get('/mnStats');
  return response.data;
}

export async function fetchNodeHistory() {
  const response = await client.get('/mnCount');
  return response.data;
}

export async function fetchGovernanceFeed() {
  const response = await client.post('/govlist', []);
  return response.data;
}
