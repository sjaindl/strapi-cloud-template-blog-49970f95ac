import type { Schema, Struct } from '@strapi/strapi';

export interface MatchGoal extends Struct.ComponentSchema {
  collectionName: 'components_match_goals';
  info: {
    description: 'Ein Torsch\u00FCtze des Spiels: Spieler (oder Name, z. B. "Eigentor") und Anzahl Tore.';
    displayName: 'Torsch\u00FCtze';
    icon: 'football';
  };
  attributes: {
    count: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<1>;
    name: Schema.Attribute.String;
    player: Schema.Attribute.Relation<'oneToOne', 'api::player.player'>;
  };
}

export interface SharedMedia extends Struct.ComponentSchema {
  collectionName: 'components_shared_media';
  info: {
    displayName: 'Media';
    icon: 'file-video';
  };
  attributes: {
    file: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
  };
}

export interface SharedQuote extends Struct.ComponentSchema {
  collectionName: 'components_shared_quotes';
  info: {
    displayName: 'Quote';
    icon: 'indent';
  };
  attributes: {
    body: Schema.Attribute.Text;
    title: Schema.Attribute.String;
  };
}

export interface SharedRichText extends Struct.ComponentSchema {
  collectionName: 'components_shared_rich_texts';
  info: {
    description: '';
    displayName: 'Rich text';
    icon: 'align-justify';
  };
  attributes: {
    body: Schema.Attribute.RichText;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    description: '';
    displayName: 'Seo';
    icon: 'allergies';
    name: 'Seo';
  };
  attributes: {
    metaDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    metaTitle: Schema.Attribute.String & Schema.Attribute.Required;
    shareImage: Schema.Attribute.Media<'images'>;
  };
}

export interface SharedSlider extends Struct.ComponentSchema {
  collectionName: 'components_shared_sliders';
  info: {
    description: '';
    displayName: 'Slider';
    icon: 'address-book';
  };
  attributes: {
    files: Schema.Attribute.Media<'images', true>;
  };
}

export interface ShopChoice extends Struct.ComponentSchema {
  collectionName: 'components_shop_choices';
  info: {
    description: 'Eine w\u00E4hlbare Option, z. B. "L/XL". Ein Preis ersetzt den Artikelpreis, wenn diese Option gew\u00E4hlt wird.';
    displayName: 'Auswahlm\u00F6glichkeit';
    icon: 'check';
  };
  attributes: {
    label: Schema.Attribute.String & Schema.Attribute.Required;
    price: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
  };
}

export interface ShopOptionGroup extends Struct.ComponentSchema {
  collectionName: 'components_shop_option_groups';
  info: {
    description: 'Auswahl (z. B. Gr\u00F6\u00DFe mit S/M, L/XL) oder Textfeld (z. B. Initialen, Gutschein-Betrag) im Bestellformular.';
    displayName: 'Optionsgruppe';
    icon: 'bulletList';
  };
  attributes: {
    choices: Schema.Attribute.Component<'shop.choice', true>;
    kind: Schema.Attribute.Enumeration<['Auswahl', 'Text']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'Auswahl'>;
    label: Schema.Attribute.String & Schema.Attribute.Required;
    placeholder: Schema.Attribute.String;
    required: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
  };
}

declare module '@strapi/strapi' {
  export namespace Public {
    export interface ComponentSchemas {
      'match.goal': MatchGoal;
      'shared.media': SharedMedia;
      'shared.quote': SharedQuote;
      'shared.rich-text': SharedRichText;
      'shared.seo': SharedSeo;
      'shared.slider': SharedSlider;
      'shop.choice': ShopChoice;
      'shop.option-group': ShopOptionGroup;
    }
  }
}
