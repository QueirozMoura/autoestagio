import { describe, expect, it } from 'vitest';
import { detectWorkMode } from '../../src/discovery/work-mode.js';
import { extractNeighborhood, neighborhoodText } from '../../src/discovery/neighborhood.js';
import { evaluateJob } from '../../src/eligibility/index.js';
import { job, profile } from '../helpers/eligibility.js';

const mode = (description: string) =>
  detectWorkMode({ title: 'Estágio', location: null, description });

describe('modalidade em frases declarativas da descrição', () => {
  it('lê a regra da própria vaga', () => {
    expect(
      mode(
        'Disponibilidade para estagiar 6 horas por dia, em modelo 100% presencial, na região dos Jardins.',
      ),
    ).toBe('presencial');
    expect(mode('Disponibilidade para estagiar presencialmente no turno da tarde.')).toBe(
      'presencial',
    );
    expect(mode('A vaga é remota e a jornada é de 30 horas.')).toBeNull();
    expect(mode('Trabalho em regime híbrido, 3x por semana no escritório.')).toBe('hibrido');
    expect(mode('Modelo de trabalho: remoto.')).toBe('remoto');
  });

  it('menção solta, condicional ou negada não define a modalidade', () => {
    expect(mode('Temos vagas presenciais ou remotas em diversas cidades.')).toBeNull();
    expect(mode('Não é um modelo presencial.')).toBeNull();
    expect(mode('Nossa empresa valoriza o trabalho remoto de quem quiser.')).toBeNull();
    expect(mode('')).toBeNull();
  });

  it('título e localização continuam mandando sobre a descrição', () => {
    expect(
      detectWorkMode({
        title: 'Estágio (Remoto)',
        location: null,
        description: 'modelo 100% presencial',
      }),
    ).toBe('remoto');
  });
});

describe('bairro, região e rua escritos na vaga', () => {
  it('copia só o trecho literal informado', () => {
    expect(extractNeighborhood('Atuação na região dos Jardins, em São Paulo.')).toEqual({
      area: 'Jardins',
    });
    expect(
      extractNeighborhood('Escritório no bairro de Pinheiros. Av. Brigadeiro Faria Lima, 3477.'),
    ).toMatchObject({
      area: 'Pinheiros',
      street: 'Brigadeiro Faria Lima',
    });
    expect(neighborhoodText('Na região da Faria Lima, SP.')).toBe('Faria Lima');
  });

  it('não deduz bairro da cidade nem aceita capturas genéricas', () => {
    expect(extractNeighborhood('Vaga em São Paulo, SP, na região Sul.')).toEqual({});
    expect(extractNeighborhood('Escritório na região de São Paulo.')).toEqual({});
    expect(extractNeighborhood(null)).toEqual({});
    expect(neighborhoodText('Trabalho remoto no Brasil.')).toBe('');
  });

  it('o bairro da descrição casa com o tempo CONFIRMADO no perfil (e sem ele continua indeterminado)', () => {
    const base = job({
      location: 'São Paulo, Brazil',
      workMode: 'presencial',
      description: 'Estágio presencial na região dos Jardins, em São Paulo.',
    });
    const sem = evaluateJob(profile(), base).criteria.find((c) => c.id === 'deslocamento');
    expect(sem?.outcome).toBe('indeterminado');
    expect(sem?.detail).toContain('São Paulo, Brazil — Jardins');
    const com = evaluateJob(
      profile({
        commute: [{ keywords: ['jardins'], minutesPerWay: 50, source: 'fictício, para testes' }],
      }),
      base,
    ).criteria.find((c) => c.id === 'deslocamento');
    expect(com?.outcome).toBe('atende');
  });
});
